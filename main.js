import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
// We'll dynamically load MediaPipe Hands (some CDNs don't expose it as an ES module).
let hands = null; // will be initialized by `initMediaPipeHands()`

function loadScript(src) {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = () => resolve();
        s.onerror = (e) => reject(new Error('Failed to load ' + src));
        document.head.appendChild(s);
    });
}

async function initMediaPipeHands() {
    const loadingEl = document.getElementById('loading');
    if (loadingEl) {
        loadingEl.style.display = 'block';
        loadingEl.textContent = 'Loading hand model...';
    }
    if (hands) return hands;
    if (!window.Hands) {
        // load the MediaPipe Hands script which exposes `window.Hands`
        await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js');
    }
    if (!window.Hands) throw new Error('MediaPipe Hands not available on window after script load');
    hands = new window.Hands({locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`});
    hands.setOptions({
        maxNumHands: 1,
        modelComplexity: 1,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5
    });
    hands.onResults(onHandsResults);
    if (loadingEl) loadingEl.textContent = 'Hand model loaded.';
    return hands;
}
// Note: the CDN camera_utils may not export an ES module `Camera` in all environments.
// We'll use a lightweight local wrapper that uses `getUserMedia` and feeds frames
// into the MediaPipe `hands.send()` loop. This avoids import errors in browsers
// that don't support that module path as an ES module.

/**
 * CONFIGURATION & STATE
 */
const CONFIG = {
    color: 0xff6fae,           // Rose Pink
    starColor: 0xffea70,       // Warmer Gold for individual stars

    // UPDATED: Finer, denser tree
    particleCount: 8000,
    particleSize: 0.08,
    treeHeight: 6,
    treeRadius: 2.5,
    scatterRadius: 8,
    lerpSpeed: 0.05,           // Smoothness of particle movement
    bloomStrength: 1.5,
    bloomRadius: 0.4,
    bloomThreshold: 0.1,
    videoDimFactor: 0.55,     // brightness multiplier when video is playing (0..1)
    videoDimLerp: 0.06,        // how fast brightness lerps to target
    videoDisplayOpacity: 0.92, // final opacity of the video plane in SCATTER mode (0..1)
    videoParticleDimFactor: 0.35, // multiplier for particle/bloom when video plays
    videoParticleLerp: 0.08,      // lerp speed for particle dimming

    // NEW: Spiral Band Config
    spiralCount: 600,
    spiralSize: 0.12,
    spiralColor: 0xfff2cc,     // Bright cream/gold
    spiralTurns: 5,            // Wraps around 5 times
    spiralSpeed: 0.8           // Ascending speed
};

const STATE = {
    mode: 'TREE',              // 'TREE' or 'SCATTER'
    isPlayingVideo: false,
    handDetected: false,
    handX: 0,                  // Normalized hand position -1 to 1
    gesture: 'NONE',           // 'OPEN', 'CLOSED', 'PINCH'
    rotationTarget: 0,
    videoOpacity: 0
};

// Track whether the user has interacted (used to allow unmuted playback)
let userInteracted = false;

// DOM Elements
const container = document.getElementById('canvas-container');
const overlay = document.getElementById('overlay');
const audioEl = document.getElementById('bg-music');
const videoEl = document.getElementById('video-source');
const fileInput = document.getElementById('user-audio-input');
const inputVideo = document.querySelector('.input_video');
// Video buffering/stall tracking (declared at module scope so animate() can read them)
let _videoBuffering = false;
let _lastVideoTime = 0;
let _lastVideoTimeUpdate = performance.now();
function showVideoLoading(msg) {
    const loadingEl = document.getElementById('loading');
    if (loadingEl) {
        loadingEl.style.display = 'block';
        loadingEl.textContent = msg || 'Loading...';
    }
    _videoBuffering = true;
}
function hideVideoLoading() {
    const loadingEl = document.getElementById('loading');
    if (loadingEl) loadingEl.style.display = 'none';
    _videoBuffering = false;
}
// DIAGNOSTICS: ensure the video element exists and report source/load errors
if (!videoEl) {
    console.error('Video element `#video-source` not found in DOM');
    const loadingEl = document.getElementById('loading');
    if (loadingEl) {
        loadingEl.style.display = 'block';
        loadingEl.textContent = 'Video element not found (id=video-source). Check index.html.';
    }
} else {
    try {
        const srcTag = videoEl.querySelector && videoEl.querySelector('source');
        const src = (srcTag && srcTag.src) ? srcTag.src : (videoEl.currentSrc || videoEl.src || '(no src)');
        console.log('Video element found. source=', src);
        const loadingEl = document.getElementById('loading');
        if (loadingEl) loadingEl.textContent = 'Video source: ' + src;

        videoEl.addEventListener('loadeddata', () => {
            console.log('Video loadeddata; readyState=', videoEl.readyState);
            const loadingEl = document.getElementById('loading');
            if (loadingEl) loadingEl.style.display = 'none';
        });

        videoEl.addEventListener('error', (ev) => {
            console.error('Video element error', ev, 'networkState=', videoEl.networkState, 'readyState=', videoEl.readyState);
            const loadingEl = document.getElementById('loading');
            if (loadingEl) {
                loadingEl.style.display = 'block';
                loadingEl.textContent = 'Video load error: networkState=' + videoEl.networkState + ' readyState=' + videoEl.readyState;
            }
        });

        // Buffering/stall detection and user feedback
        videoEl.addEventListener('waiting', () => {
            console.warn('Video waiting (buffering) event');
            showVideoLoading('Video buffering...');
        });
        videoEl.addEventListener('stalled', () => {
            console.warn('Video stalled');
            showVideoLoading('Video stalled — trying to recover...');
        });
        videoEl.addEventListener('playing', () => {
            hideVideoLoading();
            STATE.isPlayingVideo = true;
        });
        videoEl.addEventListener('pause', () => {
            STATE.isPlayingVideo = false;
        });
        // update last time when timeupdate fires (fallback)
        videoEl.addEventListener('timeupdate', () => {
            _lastVideoTime = videoEl.currentTime || 0;
            _lastVideoTimeUpdate = performance.now();
        });
    } catch (e) {
        console.warn('Error while inspecting video element:', e);
    }
}
// Ensure background music source is the embedded URL and try autoplay on load.
if (audioEl) {
    try {
        // Keep crossorigin set in HTML; explicitly set src here in case the HTML changes
        audioEl.src = audioEl.querySelector('source') ? audioEl.querySelector('source').src : audioEl.src || 'https://files.catbox.moe/ktakjh.mp3';
        audioEl.crossOrigin = 'anonymous';
    } catch (e) {
        console.warn('Could not set audio source programmatically:', e);
    }
}

window.addEventListener('load', async () => {
    if (!audioEl) return;
    try {
        await audioEl.play();
        console.log('Background music autoplayed');
    } catch (err) {
        // Autoplay may be blocked by browser policies — will start after user interaction.
        console.log('Autoplay blocked or failed (will start on user interaction):', err && err.message ? err.message : err);
    }
});

/**
 * THREE.JS SETUP
 */
const scene = new THREE.Scene();
// Add fog for depth
scene.fog = new THREE.FogExp2(0x050505, 0.05);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 0, 10);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
container.appendChild(renderer.domElement);

// Post-Processing (Bloom)
const renderScene = new RenderPass(scene, camera);
const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    CONFIG.bloomStrength,
    CONFIG.bloomRadius,
    CONFIG.bloomThreshold
);
const composer = new EffectComposer(renderer);
composer.addPass(renderScene);
composer.addPass(bloomPass);

// store original bloom strength so we can dim it when video plays
const ORIGINAL_BLOOM_STRENGTH = bloomPass.strength;

/**
 * PARTICLE SYSTEM
 */
// Generate texture programmatically for soft glow
function getSprite() {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext('2d');
    const gradient = context.createRadialGradient(16, 16, 0, 16, 16, 16);
    gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
    gradient.addColorStop(0.2, 'rgba(255, 255, 255, 0.8)');
    gradient.addColorStop(0.5, 'rgba(255, 255, 255, 0.2)');
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 32, 32);
    const texture = new THREE.CanvasTexture(canvas);
    return texture;
}

// Reuse a soft orb/glow texture for multiple systems
const orbTexture = getSprite();

// NEW: Create a 5-point star texture for the tree topper
function getStarTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0,0,64,64);
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = '#fffdd0';
    ctx.shadowBlur = 10;

    ctx.beginPath();
    const cx = 32, cy = 32, outerRadius = 28, innerRadius = 12;
    for (let i = 0; i < 5; i++) {
        let angle = (i * Math.PI * 2) / 5 - Math.PI / 2;
        ctx.lineTo(cx + outerRadius * Math.cos(angle), cy + outerRadius * Math.sin(angle));
        angle += Math.PI / 5;
        ctx.lineTo(cx + innerRadius * Math.cos(angle), cy + innerRadius * Math.sin(angle));
    }
    ctx.closePath();
    ctx.fill();
    return new THREE.CanvasTexture(canvas);
}

const geometry = new THREE.BufferGeometry();
const positions = [];
const targetPositions = []; // Target state (Tree or Scatter)
const treePositions = [];   // Pre-calculated Tree coords
const scatterPositions = [];// Pre-calculated Scatter coords
const colors = [];
const colorObj = new THREE.Color(CONFIG.color);
const starColorObj = new THREE.Color(CONFIG.starColor);

// Initialize particles
// Create a glowing spiral tree: particles are placed along a tight upward spiral
// so the assembled tree looks like a continuous spiral of shimmering particles.
for (let i = 0; i < CONFIG.particleCount; i++) {
    // 1. Calculate Tree Shape (Cone)
    const h = Math.random() * CONFIG.treeHeight - (CONFIG.treeHeight / 2);
    const normH = (h + CONFIG.treeHeight/2) / CONFIG.treeHeight; // 0 to 1
    const r = (1 - normH) * CONFIG.treeRadius;
    const angle = Math.random() * Math.PI * 2;
    const spiral = h * 2;

    const tx = Math.cos(angle + spiral) * r;
    const ty = h;
    const tz = Math.sin(angle + spiral) * r;

    treePositions.push(tx, ty, tz);

    // 2. Calculate Scatter Shape (Sphere/Cloud)
    const sr = CONFIG.scatterRadius * Math.cbrt(Math.random()); // Uniform sphere
    const theta = Math.random() * 2 * Math.PI;
    const phi = Math.acos(2 * Math.random() - 1);
    const sx = sr * Math.sin(phi) * Math.cos(theta);
    const sy = sr * Math.sin(phi) * Math.sin(theta);
    const sz = sr * Math.cos(phi);

    scatterPositions.push(sx, sy, sz);

    // Initial State = Tree
    positions.push(tx, ty, tz);
    targetPositions.push(tx, ty, tz);

    // Colors: mostly pink, some gold stars
    if (Math.random() > 0.9) {
        colors.push(starColorObj.r, starColorObj.g, starColorObj.b);
    } else {
        colors.push(colorObj.r, colorObj.g, colorObj.b);
    }
}

geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

const material = new THREE.PointsMaterial({
    size: CONFIG.particleSize,
    map: orbTexture,
    vertexColors: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
    opacity: 0.8
});

// store original particle material values to restore/lerp against
const ORIGINAL_PARTICLE_OPACITY = material.opacity;
const ORIGINAL_PARTICLE_SIZE = material.size;

const particleSystem = new THREE.Points(geometry, material);
scene.add(particleSystem);

// (Removed enhanced glow/star/background to restore original rose-pink tree look)

// --- SPIRAL SYSTEM (secondary band slightly outside the main tree) ---
const spiralGeo = new THREE.BufferGeometry();
const spiralPositions = [];
const spiralBaseTreeCoords = []; // store the base positions for upward flow
const spiralScatterCoords = [];

for (let i = 0; i < CONFIG.spiralCount; i++) {
    const pct = i / CONFIG.spiralCount; // 0..1
    const h = (pct * CONFIG.treeHeight) - (CONFIG.treeHeight / 2);
    const r = (1 - pct) * CONFIG.treeRadius * 1.15 + 0.2; // slightly wider than tree
    const angle = pct * Math.PI * 2 * CONFIG.spiralTurns;

    const tx = Math.cos(angle) * r;
    const ty = h;
    const tz = Math.sin(angle) * r;

    spiralBaseTreeCoords.push(tx, ty, tz);
    spiralPositions.push(tx, ty, tz);

    // simple scatter coords for spiral band when scattering
    const sr = CONFIG.scatterRadius * Math.cbrt(Math.random());
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const sx = sr * Math.sin(phi) * Math.cos(theta);
    const sy = sr * Math.sin(phi) * Math.sin(theta);
    const sz = sr * Math.cos(phi);
    spiralScatterCoords.push(sx, sy, sz);
}

spiralGeo.setAttribute('position', new THREE.Float32BufferAttribute(spiralPositions, 3));

const spiralMaterial = new THREE.PointsMaterial({
    size: CONFIG.spiralSize,
    color: CONFIG.spiralColor,
    map: orbTexture,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
    opacity: 0.9
});

const spiralSystem = new THREE.Points(spiralGeo, spiralMaterial);
scene.add(spiralSystem);

// --- TOP STAR (particle-based) ---
const STAR_PARTICLE_COUNT = 256;
const starGeo = new THREE.BufferGeometry();
const starPositions = [];
const treeTopY = (CONFIG.treeHeight / 2) + 0.2;
for (let i = 0; i < STAR_PARTICLE_COUNT; i++) {
    const a = (i / STAR_PARTICLE_COUNT) * Math.PI * 2;
    // Use 5-point star modulation: radius oscillates with sin(5*a)
    const mod = Math.sign(Math.sin(a * 5)) > 0 ? 1 : 0.45;
    const outer = 0.45 * mod + (Math.random() * 0.06);
    const inner = 0.18 * mod + (Math.random() * 0.04);
    const r = (Math.sin(a * 5) > 0) ? outer : inner;
    const jitter = (Math.random() - 0.5) * 0.05;
    const x = Math.cos(a) * r + jitter;
    const y = treeTopY + (Math.random() - 0.5) * 0.06;
    const z = Math.sin(a) * r + (Math.random() - 0.5) * 0.05;
    starPositions.push(x, y, z);
}
starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPositions, 3));

// Store base positions for the star shape and create scatter target positions
const starBasePositions = new Float32Array(starPositions);
const starScatterPositions = new Float32Array(STAR_PARTICLE_COUNT * 3);
for (let i = 0; i < STAR_PARTICLE_COUNT; i++) {
    // Scatter outward from tree top: random direction and distance
    const sx = (Math.random() - 0.5) * CONFIG.scatterRadius * 2.0;
    const sy = treeTopY + (Math.random() * CONFIG.treeHeight * 0.8) + 0.2; // float upward a bit
    const sz = (Math.random() - 0.5) * CONFIG.scatterRadius * 2.0;
    starScatterPositions[i * 3] = sx;
    starScatterPositions[i * 3 + 1] = sy;
    starScatterPositions[i * 3 + 2] = sz;
}

const starMaterial = new THREE.PointsMaterial({
    size: CONFIG.particleSize * 1.8,
    map: getStarTexture(),
    color: CONFIG.starColor,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
    opacity: 1.0
});
const starPoints = new THREE.Points(starGeo, starMaterial);
scene.add(starPoints);
const ORIGINAL_STAR_SIZE = starMaterial.size;

/**
 * VIDEO PLANE
 */
const videoTexture = new THREE.VideoTexture(videoEl);
videoTexture.minFilter = THREE.LinearFilter;
videoTexture.magFilter = THREE.LinearFilter;
videoTexture.generateMipmaps = false;
// Try to use the maximum anisotropy available to keep the video crisp when scaled
const maxAniso = (renderer.capabilities && typeof renderer.capabilities.getMaxAnisotropy === 'function') ? renderer.capabilities.getMaxAnisotropy() : (renderer.capabilities ? renderer.capabilities.maxAnisotropy || 0 : 0);
if (maxAniso) videoTexture.anisotropy = maxAniso;

const videoGeo = new THREE.PlaneGeometry(4, 2.25); // 16:9 aspect ratio
const videoMat = new THREE.MeshBasicMaterial({ 
    map: videoTexture, 
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0,
    depthWrite: false // do not write to depth so particles can be rendered on top
});
const videoPlane = new THREE.Mesh(videoGeo, videoMat);
// Start the video plane slightly behind the particle system; bring forward when showing
videoPlane.position.set(0, 0, -5);
scene.add(videoPlane);

// Ensure render order so we can bring the video plane in front when needed
videoPlane.renderOrder = 0;
particleSystem.renderOrder = 1;

// When the video's metadata loads, resize the plane to match the native aspect
videoEl.addEventListener('loadedmetadata', () => {
    try {
        const vw = videoEl.videoWidth || 16;
        const vh = videoEl.videoHeight || 9;
        const aspect = vw / vh;
        // Choose a display height in world units for the plane (keeps visual size consistent)
        const displayHeight = 3.5; // world units; tweakable
        // Rebuild geometry to match native aspect ratio so pixels map correctly
        videoPlane.geometry.dispose();
        videoPlane.geometry = new THREE.PlaneGeometry(aspect * displayHeight, displayHeight);
        // Ensure the material uses the updated texture and respects original colors
        videoPlane.material.map = videoTexture;
        videoPlane.material.needsUpdate = true;
    } catch (err) {
        console.warn('Could not resize video plane to native aspect:', err);
    }
});

/**
 * AUDIO HANDLING
 */
let audioCtxAllowed = false;

function fadeAudio(targetVolume) {
    if (!audioEl) return;
    // Simple manual lerp for volume
    const current = audioEl.volume;
    const diff = targetVolume - current;
    if (Math.abs(diff) > 0.01) {
        audioEl.volume += diff * 0.05;
    } else {
        audioEl.volume = targetVolume;
    }
}

let started = false;

async function handleOverlayClick() {
    if (started) return;
    started = true;

    // 淡出 overlay
    overlay.style.opacity = '0';
    setTimeout(() => {
        overlay.style.display = 'none';
    }, 500);

    // 解锁音频
    audioCtxAllowed = true;

    // mark that the user interacted (click) so we can allow unmuted playback
    userInteracted = true;

    // Do not auto-open file picker when using embedded background music.

    const loadingEl = document.getElementById('loading');
    if (loadingEl) {
        loadingEl.style.display = 'block';
        loadingEl.textContent = 'Initializing Neural Net & Graphics...';
    }

        // ✅ Initialize MediaPipe Hands and start the camera loop
        try {
            await initMediaPipeHands();
        } catch (err) {
            console.error('Failed to initialize MediaPipe Hands:', err);
            const loadingEl = document.getElementById('loading');
            if (loadingEl) {
                loadingEl.style.display = 'block';
                loadingEl.textContent = 'Error loading hand model: ' + (err && err.message ? err.message : String(err));
            }
            return;
        }

        if (mediaCamera) {
            try {
                await mediaCamera.start();
            } catch (err) {
                console.error('Failed to start mediaCamera:', err);
                const loadingEl = document.getElementById('loading');
                if (loadingEl) {
                    loadingEl.style.display = 'block';
                    loadingEl.textContent = 'Error starting camera: ' + (err && err.message ? err.message : String(err));
                }
            }
        }

        // Since the user clicked to start, allow video sound and attempt playback
        try {
            if (videoEl) {
                videoEl.muted = false;
                videoEl.volume = 1.0;
                // try to play in case it was previously blocked or paused
                const p = videoEl.play();
                if (p && p.then) p.catch(() => {});
            }
        } catch (e) {
            console.warn('Could not unmute/play video immediately:', e);
        }

    // 播放默认音乐（如果有）
    if (audioEl && audioEl.src) {
        try {
            audioEl.volume = 0.5;
            await audioEl.play();
        } catch (e) {
            console.log('Audio will play after file selection');
        }
    }

    console.log('INTERACTIVE DREAM TREE STARTED');
}

overlay.addEventListener('click', handleOverlayClick);
// Also listen for the inline fallback event in case the module loads after a user click
document.addEventListener('user-start', handleOverlayClick);

fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        const objectUrl = URL.createObjectURL(file);
        audioEl.src = objectUrl;
        audioEl.play();
    }
});

/**
 * MEDIAPIPE LOGIC
 */
// MediaPipe Hands is initialized dynamically via `initMediaPipeHands()` above.

// Local mediaCamera wrapper: uses getUserMedia and an RAF loop to send frames
// into MediaPipe Hands. This avoids importing Camera from the CDN which may
// not be available as an ES module in some setups.
const mediaCamera = (function(){
    let stream = null;
    let rafId = null;
    let running = false;

    async function start() {
        if (running) return;
        try {
            const loadingEl = document.getElementById('loading');
            if (loadingEl) {
                loadingEl.style.display = 'block';
                loadingEl.textContent = 'Requesting camera permission...';
            }
            stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
            inputVideo.srcObject = stream;
            await inputVideo.play();
            running = true;
            if (loadingEl) loadingEl.textContent = 'Camera started — waiting for frames...';

            async function frameLoop() {
                if (!running) return;
                try {
                    await hands.send({ image: inputVideo });
                } catch (err) {
                    console.error('Error sending frame to MediaPipe Hands:', err);
                    const loadingEl = document.getElementById('loading');
                    if (loadingEl) {
                        loadingEl.style.display = 'block';
                        loadingEl.textContent = 'Error during frame processing: ' + (err && err.message ? err.message : String(err));
                    }
                }
                rafId = requestAnimationFrame(frameLoop);
            }

            frameLoop();
        } catch (err) {
            // Propagate so callers can handle (we already wrap mediaCamera.start() elsewhere)
            throw err;
        }
    }

    function stop() {
        running = false;
        if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = null;
        }
        if (stream) {
            stream.getTracks().forEach(t => t.stop());
            stream = null;
        }
    }

    return { start, stop };
})();

// Note: call `mediaCamera.start()` only after user interaction (see handleOverlayClick)

// Global error handlers to surface runtime issues to the page for easier debugging
window.addEventListener('error', (ev) => {
    const msg = ev.error && ev.error.stack ? ev.error.stack : (ev.message || String(ev));
    const info = (ev.filename ? `${ev.filename}:${ev.lineno}:${ev.colno}` : '');
    console.error('Global error', info, ev.error || ev.message || ev);
    const loadingEl = document.getElementById('loading');
    if (loadingEl) {
        loadingEl.style.display = 'block';
        loadingEl.textContent = 'Runtime error: ' + msg + (info ? (' @ ' + info) : '');
    }
});

window.addEventListener('unhandledrejection', (ev) => {
    const reason = ev.reason || ev;
    console.error('Unhandled rejection:', reason);
    const loadingEl = document.getElementById('loading');
    if (loadingEl) {
        loadingEl.style.display = 'block';
        loadingEl.textContent = 'Unhandled promise rejection: ' + (reason && reason.stack ? reason.stack : (reason && reason.message ? reason.message : String(reason)));
    }
});

function onHandsResults(results) {
    STATE.handDetected = false;
    document.getElementById('loading').style.display = 'none'; // Hide loading once we get data

    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
        STATE.handDetected = true;
        const landmarks = results.multiHandLandmarks[0];

        // 1. Detect Hand Position (X) for Rotation
        // MediaPipe X is 0 (left) to 1 (right). Center is 0.5.
        // We map this to rotation speed or target angle.
        // Let's map 0..1 to -PI..PI
        const wrist = landmarks[0];
        STATE.handX = (wrist.x - 0.5) * 2; // -1 to 1

        // 2. Detect Gestures
        
        // Is Hand Open or Closed?
        // Check if fingertips are above (y < mcp_y) or below knuckles? No, orientation varies.
        // Better: Average distance of finger tips from wrist.
        const tips = [8, 12, 16, 20]; // Index, Middle, Ring, Pinky
        const wristPos = new THREE.Vector3(landmarks[0].x, landmarks[0].y, 0);
        
        let avgDist = 0;
        tips.forEach(idx => {
            const tipPos = new THREE.Vector3(landmarks[idx].x, landmarks[idx].y, 0);
            avgDist += wristPos.distanceTo(tipPos);
        });
        avgDist /= 4;

        // Determine Open vs Closed
        // Threshold needs tuning, usually around 0.2 for closed, 0.4+ for open in normalized coords
        const isClosed = avgDist < 0.25;
        const isOpen = avgDist > 0.35;

        if (isClosed) {
            STATE.gesture = 'CLOSED';
            STATE.mode = 'TREE';
        } else if (isOpen) {
            STATE.gesture = 'OPEN';
            STATE.mode = 'SCATTER';
        }

        // 3. Detect Pinch (Index 8 and Thumb 4)
        const thumbTip = new THREE.Vector3(landmarks[4].x, landmarks[4].y, 0);
        const indexTip = new THREE.Vector3(landmarks[8].x, landmarks[8].y, 0);
        const pinchDist = thumbTip.distanceTo(indexTip);

        if (pinchDist < 0.05) {
            STATE.gesture = 'PINCH';
            // Only toggle video if we are in scatter mode and video is visible
            if (STATE.mode === 'SCATTER' && STATE.videoOpacity > 0.8) {
                if (!STATE.isPlayingVideo) {
                    STATE.isPlayingVideo = true;
                    videoEl.play();
                }
            }
        } else {
            // If we release pinch, do we stop video? 
            // The prompt says "Selects and plays". It doesn't explicitly say stop on release.
            // But usually, if we switch back to TREE mode, video should hide/stop.
        }
    }
}


/**
 * ANIMATION LOOP
 */
const clock = new THREE.Clock();
let _prevMode = STATE.mode; // track mode changes to trigger side effects (like video play)

function animate() {
    requestAnimationFrame(animate);

    const delta = clock.getDelta();
    const time = clock.getElapsedTime();

    // 1. Handle State Transitions
    if (STATE.mode === 'TREE') {
        // Stop video if playing
        if (STATE.isPlayingVideo) {
            STATE.isPlayingVideo = false;
            videoEl.pause();
        }
    }

    // 2. Audio Fading
    // If video is playing, mute music. Else play music.
    const targetVol = STATE.isPlayingVideo ? 0 : 0.5;
    fadeAudio(targetVol);

    // Dim particle light (bloom + particle opacity/size) when video plays
    const targetParticleOpacity = STATE.isPlayingVideo ? ORIGINAL_PARTICLE_OPACITY * CONFIG.videoParticleDimFactor : ORIGINAL_PARTICLE_OPACITY;
    material.opacity = THREE.MathUtils.lerp(material.opacity, targetParticleOpacity, CONFIG.videoParticleLerp);

    const targetBloom = STATE.isPlayingVideo ? ORIGINAL_BLOOM_STRENGTH * CONFIG.videoParticleDimFactor : ORIGINAL_BLOOM_STRENGTH;
    bloomPass.strength = THREE.MathUtils.lerp(bloomPass.strength, targetBloom, CONFIG.videoParticleLerp);

    // 3. Video Plane Opacity
    let targetOpacity = (STATE.mode === 'SCATTER') ? CONFIG.videoDisplayOpacity : 0.0;
    STATE.videoOpacity = THREE.MathUtils.lerp(STATE.videoOpacity, targetOpacity, 0.05);
    videoPlane.material.opacity = STATE.videoOpacity;
    
    // Scale video plane for pop-in effect; make it larger and clearer in SCATTER mode
    const targetScale = (STATE.mode === 'SCATTER') ? 1.8 : 0; // larger multiplier when scattered
    const scale = THREE.MathUtils.lerp(videoPlane.scale.x, targetScale, 0.08);
    videoPlane.scale.set(scale, scale, 1);

    // Dim video brightness smoothly when the video is playing to reduce glare
    const targetBrightness = STATE.isPlayingVideo ? CONFIG.videoDimFactor : 1.0;
    // assume material.color r/g/b are equal; lerp the scalar brightness
    const currentBrightness = videoPlane.material.color.r;
    const newBrightness = THREE.MathUtils.lerp(currentBrightness, targetBrightness, CONFIG.videoDimLerp);
    videoPlane.material.color.setRGB(newBrightness, newBrightness, newBrightness);
    
    // Make video look at camera always
    videoPlane.lookAt(camera.position);

    // If mode changed, run any start/stop actions (try to auto-play video on SCATTER)
    if (STATE.mode !== _prevMode) {
        // entering SCATTER: try to autoplay the video (muted) for visual playback
        if (STATE.mode === 'SCATTER' && videoEl) {
            try {
                // ensure src is set from source element if present
                const srcTag = videoEl.querySelector && videoEl.querySelector('source');
                if (srcTag && srcTag.src) videoEl.src = srcTag.src;
                // mute only if the user hasn't interacted yet; if they have, allow audio
                videoEl.muted = !userInteracted; // mute to allow autoplay in browsers when needed
                const p = videoEl.play();
                if (p && p.then) {
                    p.then(() => {
                        STATE.isPlayingVideo = true;
                        const loadingEl = document.getElementById('loading');
                        if (loadingEl) {
                            loadingEl.style.display = 'none';
                        }
                        console.log('Video autoplay succeeded (muted).');
                    }).catch((err) => {
                        console.warn('Video autoplay failed:', err);
                        const loadingEl = document.getElementById('loading');
                        if (loadingEl) {
                            loadingEl.style.display = 'block';
                            loadingEl.textContent = 'Video autoplay blocked: ' + (err && err.message ? err.message : String(err));
                        }
                    });
                }
            } catch (err) {
                console.error('Error attempting video.play():', err);
                const loadingEl = document.getElementById('loading');
                if (loadingEl) {
                    loadingEl.style.display = 'block';
                    loadingEl.textContent = 'Error starting video: ' + (err && err.message ? err.message : String(err));
                }
            }
        }

        // leaving SCATTER: pause video
        if (STATE.mode !== 'SCATTER' && videoEl && !videoEl.paused) {
            try { videoEl.pause(); STATE.isPlayingVideo = false; } catch (e) { /* ignore */ }
        }

        _prevMode = STATE.mode;
    }

    // Bring the video plane forward when in SCATTER, else move it back
    const targetZ = (STATE.mode === 'SCATTER') ? 0.5 : -5;
    videoPlane.position.z = THREE.MathUtils.lerp(videoPlane.position.z, targetZ, 0.06);

    // Ensure the video texture updates while playing so it appears
    if (typeof videoTexture !== 'undefined' && videoEl && !videoEl.paused) {
        videoTexture.needsUpdate = true;

        // Fallback stutter detection: if currentTime isn't advancing for a short period,
        // show the loading indicator to indicate buffering or network issues.
        try {
            const now = performance.now();
            const ct = videoEl.currentTime || 0;
            if (Math.abs(ct - _lastVideoTime) > 0.03) {
                _lastVideoTime = ct;
                _lastVideoTimeUpdate = now;
                if (_videoBuffering) hideVideoLoading();
            } else {
                if (now - _lastVideoTimeUpdate > 750) {
                    showVideoLoading('Video buffering...');
                }
            }
        } catch (e) {
            // ignore
        }
    }

    // 4. Update Rotation
    // If hand is detected, rotate based on handX
    if (STATE.handDetected) {
        // Map hand X (-1 to 1) to a rotation speed or target angle
        // Let's do simple continuous rotation influenced by hand position
        const targetRotY = STATE.handX * 2; // -2 to 2 radians
        particleSystem.rotation.y = THREE.MathUtils.lerp(particleSystem.rotation.y, particleSystem.rotation.y + (STATE.handX * 0.05), 0.1);
    } else {
        // Idle rotation
        particleSystem.rotation.y += 0.002;
    }

    // --- Update Spiral Positions (flowing upward band) ---
    if (typeof spiralGeo !== 'undefined' && spiralGeo && spiralGeo.attributes && spiralGeo.attributes.position) {
        const spiralPosAttr = spiralGeo.attributes.position;
        const treeHeightSpan = CONFIG.treeHeight;
        const treeTop = CONFIG.treeHeight / 2;

        for (let i = 0; i < CONFIG.spiralCount; i++) {
            const pct = i / CONFIG.spiralCount; // 0..1
            const baseTy = (pct * CONFIG.treeHeight) - (CONFIG.treeHeight / 2);

            let ty;

            if (STATE.mode === 'TREE') {
                let flowOffset = (time * CONFIG.spiralSpeed) % treeHeightSpan;
                ty = baseTy + flowOffset;
                if (ty > treeTop) ty -= treeHeightSpan;

                // compute normalized height (0..1) for angle/radius
                const normH = (ty + (CONFIG.treeHeight / 2)) / CONFIG.treeHeight;
                const angle = normH * Math.PI * 2 * CONFIG.spiralTurns + (time * CONFIG.spiralSpeed);
                const r = (1 - normH) * CONFIG.treeRadius * 1.15 + 0.2;
                const x = Math.cos(angle) * r;
                const z = Math.sin(angle) * r;

                spiralPosAttr.setXYZ(i, x, ty, z);
            } else {
                // SCATTER: use precomputed scatter coordinates
                const sx = spiralScatterCoords[i*3];
                const sy = spiralScatterCoords[i*3+1];
                const sz = spiralScatterCoords[i*3+2];
                spiralPosAttr.setXYZ(i, sx, sy, sz);
            }
        }

        spiralPosAttr.needsUpdate = true;
    }

    // Twinkle the Top Star (particle-based) and optionally scatter apart
    if (typeof starPoints !== 'undefined' && starPoints) {
        const twinkle = 0.8 + Math.sin(time * 3) * 0.2;
        starMaterial.size = ORIGINAL_STAR_SIZE * twinkle;
        starMaterial.needsUpdate = true;

        // Update star particle positions: lerp between base (assembled star)
        // and scatter targets when in SCATTER mode
        const starPosAttr = starGeo.attributes.position;
        const starLerp = CONFIG.lerpSpeed * 2.0;
        for (let i = 0; i < STAR_PARTICLE_COUNT; i++) {
            const cx = starPosAttr.getX(i);
            const cy = starPosAttr.getY(i);
            const cz = starPosAttr.getZ(i);

            let tx = starBasePositions[i * 3];
            let ty = starBasePositions[i * 3 + 1];
            let tz = starBasePositions[i * 3 + 2];

            if (STATE.mode === 'SCATTER') {
                tx = starScatterPositions[i * 3];
                ty = starScatterPositions[i * 3 + 1];
                tz = starScatterPositions[i * 3 + 2];
            }

            const nx = THREE.MathUtils.lerp(cx, tx, starLerp);
            const ny = THREE.MathUtils.lerp(cy, ty, starLerp);
            const nz = THREE.MathUtils.lerp(cz, tz, starLerp);

            starPosAttr.setXYZ(i, nx, ny, nz);
        }
        starPosAttr.needsUpdate = true;
    }

    // 5. Update Particles
    const positionsAttr = geometry.attributes.position;
    
    for (let i = 0; i < CONFIG.particleCount; i++) {
        const px = positionsAttr.getX(i);
        const py = positionsAttr.getY(i);
        const pz = positionsAttr.getZ(i);

        let tx, ty, tz;

        if (STATE.mode === 'TREE') {
            tx = treePositions[i * 3];
            ty = treePositions[i * 3 + 1];
            tz = treePositions[i * 3 + 2];
        } else {
            // SCATTER
            tx = scatterPositions[i * 3];
            ty = scatterPositions[i * 3 + 1];
            tz = scatterPositions[i * 3 + 2];
            
            // Add subtle floating noise in scatter mode
            ty += Math.sin(time + tx) * 0.005;
        }

        // Lerp current position to target
        const nx = THREE.MathUtils.lerp(px, tx, CONFIG.lerpSpeed);
        const ny = THREE.MathUtils.lerp(py, ty, CONFIG.lerpSpeed);
        const nz = THREE.MathUtils.lerp(pz, tz, CONFIG.lerpSpeed);

        positionsAttr.setXYZ(i, nx, ny, nz);
    }

    positionsAttr.needsUpdate = true;

    // Render
    composer.render();
}

// Handle Window Resize
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
});

// Start Animation
animate();