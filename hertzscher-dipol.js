(() => {
  'use strict';

  const viewport = document.getElementById('dipoleViewport');
  if (!viewport) return;

  const showFallback = message => {
    const fallback = document.createElement('div');
    fallback.className = 'dipole-fallback';
    fallback.textContent = message;
    viewport.appendChild(fallback);
  };

  if (!window.THREE) {
    showFallback('Die 3D-Bibliothek konnte nicht geladen werden. Die übrigen Lernstationen funktionieren weiterhin.');
    return;
  }

  const T = window.THREE;
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const TWO_PI = Math.PI * 2;
  const AXIS = new T.Vector3(0, 1, 0);
  const C_MODEL = 1;
  const OMEGA = 1.05;
  const K = OMEGA / C_MODEL;
  const SOURCE_CUTOFF = 0.42;
  const FIELD_LIMIT = 6.8;
  const ELECTRIC_COLOR = 0x4b9cff;
  const MAGNETIC_COLOR = 0xff7043;
  const ENERGY_COLOR = 0xfbbf24;
  const CHARGE_COLOR = 0xc4b5fd;

  let renderer;
  try {
    renderer = new T.WebGLRenderer({antialias: true, alpha: true, powerPreference: 'high-performance'});
  } catch (error) {
    showFallback('Auf diesem Gerät konnte keine WebGL-Darstellung gestartet werden.');
    return;
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.8));
  renderer.setClearColor(0x07111f, 0);
  renderer.domElement.setAttribute('aria-hidden', 'true');
  viewport.insertBefore(renderer.domElement, viewport.firstChild);

  const scene = new T.Scene();
  scene.fog = new T.FogExp2(0x06101d, 0.036);
  const camera = new T.PerspectiveCamera(46, 1, 0.08, 60);
  const cameraState = {yaw: 0.72, pitch: 0.34, radius: 10.8};
  const cameraTarget = new T.Vector3(0, 0, 0);

  const updateCamera = () => {
    const cp = Math.cos(cameraState.pitch);
    camera.position.set(
      cameraState.radius * cp * Math.sin(cameraState.yaw),
      cameraState.radius * Math.sin(cameraState.pitch),
      cameraState.radius * cp * Math.cos(cameraState.yaw)
    );
    camera.lookAt(cameraTarget);
  };
  updateCamera();

  scene.add(new T.AmbientLight(0xa9c8ff, 0.72));
  const keyLight = new T.DirectionalLight(0xffffff, 1.05);
  keyLight.position.set(5, 7, 6);
  scene.add(keyLight);
  const rimLight = new T.PointLight(0x5b8cff, 1.15, 16);
  rimLight.position.set(-4, 1.5, -3);
  scene.add(rimLight);

  const sourceGroup = new T.Group();
  const electricGroup = new T.Group();
  const magneticGroup = new T.Group();
  const frontGroup = new T.Group();
  const energyGroup = new T.Group();
  const vectorGroup = new T.Group();
  scene.add(sourceGroup, electricGroup, magneticGroup, frontGroup, energyGroup, vectorGroup);

  const layers = {electric: true, magnetic: true, fronts: true, energy: true};
  let running = true;
  let vectorsForced = false;
  let speed = 0.7;
  let phase = 0.6;
  let inView = true;
  let lastFrame = performance.now();
  let lastFieldUpdate = 0;

  // Dipol und Ladungsträger -------------------------------------------------
  const metalMaterial = new T.MeshStandardMaterial({
    color: 0xb8c5d7,
    metalness: 0.82,
    roughness: 0.24,
    emissive: 0x122033,
    emissiveIntensity: 0.35,
    transparent: true,
    opacity: 0.34,
    depthWrite: false
  });
  const rodGeometry = new T.CylinderGeometry(0.105, 0.105, 1.72, 24);
  const topRod = new T.Mesh(rodGeometry, metalMaterial);
  const bottomRod = new T.Mesh(rodGeometry, metalMaterial);
  topRod.position.y = 0.96;
  bottomRod.position.y = -0.96;
  sourceGroup.add(topRod, bottomRod);

  const feedMaterial = new T.MeshBasicMaterial({color: 0xffd166, transparent: true, opacity: 0.82});
  const feed = new T.Mesh(new T.SphereGeometry(0.105, 18, 12), feedMaterial);
  sourceGroup.add(feed);
  const feedGlow = new T.PointLight(0xffb84d, 1.1, 3.2);
  sourceGroup.add(feedGlow);

  const ionMaterial = new T.MeshBasicMaterial({color: 0x9aa8ba, transparent: true, opacity: 0.48});
  const ionGeometry = new T.SphereGeometry(0.022, 8, 6);
  [-1, 1].forEach(sign => {
    for (let i = 0; i < 16; i++) {
      const ion = new T.Mesh(ionGeometry, ionMaterial);
      const angle = i * 2.399;
      ion.position.set(0.065 * Math.cos(angle), sign * (0.23 + (i % 8) * 0.2), 0.065 * Math.sin(angle));
      sourceGroup.add(ion);
    }
  });

  const electronGeometry = new T.SphereGeometry(0.064, 16, 12);
  const electronMaterial = new T.MeshBasicMaterial({color: CHARGE_COLOR});
  const electronTrailMaterial = new T.LineBasicMaterial({
    color: 0xe9d5ff,
    transparent: true,
    opacity: 0.72,
    blending: T.AdditiveBlending,
    depthWrite: false
  });
  const electrons = [];
  [-1, 1].forEach(sign => {
    for (let i = 0; i < 7; i++) {
      const electron = new T.Mesh(electronGeometry, electronMaterial);
      const angle = i * 2.18 + (sign < 0 ? 0.7 : 0);
      electron.userData.baseY = sign * (0.34 + i * 0.215);
      electron.userData.x = 0.045 * Math.cos(angle);
      electron.userData.z = 0.045 * Math.sin(angle);
      electron.renderOrder = 3;
      sourceGroup.add(electron);
      const trailPositions = new Float32Array(6);
      const trailGeometry = new T.BufferGeometry();
      trailGeometry.setAttribute('position', new T.BufferAttribute(trailPositions, 3));
      const trail = new T.Line(trailGeometry, electronTrailMaterial);
      trail.frustumCulled = false;
      trail.renderOrder = 4;
      sourceGroup.add(trail);
      const velocityArrow = new T.ArrowHelper(AXIS, new T.Vector3(), 0.25, 0xffffff, 0.075, 0.045);
      vectorGroup.add(velocityArrow);
      electrons.push({mesh: electron, arrow: velocityArrow, trail, trailPositions});
    }
  });

  const endCharges = [];
  const chargeGeometry = new T.SphereGeometry(0.042, 12, 8);
  [-1, 1].forEach(sign => {
    for (let i = 0; i < 10; i++) {
      const material = new T.MeshBasicMaterial({color: 0xff6b6b, transparent: true, opacity: 0.7});
      const charge = new T.Mesh(chargeGeometry, material);
      const angle = i / 10 * TWO_PI;
      charge.position.set(0.145 * Math.cos(angle), sign * 1.84, 0.145 * Math.sin(angle));
      charge.userData.endSign = sign;
      sourceGroup.add(charge);
      endCharges.push(charge);
    }
  });

  const sourceAxisMaterial = new T.LineDashedMaterial({color: 0xa9bdd4, transparent: true, opacity: 0.28, dashSize: 0.16, gapSize: 0.11});
  const sourceAxis = new T.Line(
    new T.BufferGeometry().setFromPoints([new T.Vector3(0, -3.3, 0), new T.Vector3(0, 3.3, 0)]),
    sourceAxisMaterial
  );
  sourceAxis.computeLineDistances();
  sourceGroup.add(sourceAxis);

  // Analytisches Feld des Hertzschen Dipols -------------------------------
  // Normierte Form der vollständigen retardierten Dipolfelder. Sichtbar sind
  // der 1/r³-, 1/r²- und 1/r-Anteil; nur gemeinsame Konstanten sind weggelassen.
  const fieldAt = (position, sourcePhase) => {
    const r = Math.max(position.length(), SOURCE_CUTOFF);
    const n = position.clone().multiplyScalar(1 / r);
    const cosTheta = n.y;
    const retardedPhase = sourcePhase - K * r;
    const p = Math.cos(retardedPhase);
    const pDot = -OMEGA * Math.sin(retardedPhase);
    const pDDot = -OMEGA * OMEGA * Math.cos(retardedPhase);
    const nearInduction = p / (r * r * r) + pDot / (C_MODEL * r * r);
    const radiation = pDDot / (C_MODEL * C_MODEL * r);

    const chargeShape = n.clone().multiplyScalar(3 * cosTheta).sub(AXIS);
    const transverseShape = n.clone().multiplyScalar(cosTheta).sub(AXIS);
    const E = chargeShape.multiplyScalar(nearInduction).add(transverseShape.multiplyScalar(radiation));

    const azimuthal = AXIS.clone().cross(n);
    const bAmplitude = pDot / (C_MODEL * r * r) + pDDot / (C_MODEL * C_MODEL * r);
    const B = azimuthal.multiplyScalar(bAmplitude);
    return {E, B, r, retardedPhase, p, pDot, pDDot};
  };

  // Elektrische Feldlinien: numerische Momentan-Stromlinien ----------------
  const MAX_LINE_POINTS = 175;
  const electricLines = [];
  const electricMaterial = new T.LineBasicMaterial({
    color: ELECTRIC_COLOR,
    transparent: true,
    opacity: 0.68,
    blending: T.AdditiveBlending,
    depthWrite: false
  });
  // Wegen der Rotationssymmetrie genügt eine Rechnung in einer Meridianebene.
  // Diese Grundlinien werden anschließend exakt in acht gleiche Raumrichtungen
  // gedreht. So bleibt die Darstellung auch numerisch vollkommen symmetrisch.
  const baseSeedDirections = [35, 62, 118, 145].map(degrees => {
    const theta = degrees * Math.PI / 180;
    return new T.Vector3(Math.sin(theta), Math.cos(theta), 0).multiplyScalar(0.52);
  });
  const electricSeeds = [];
  baseSeedDirections.forEach((seed, thetaIndex) => {
    for (let azimuthIndex = 0; azimuthIndex < 8; azimuthIndex++) {
      electricSeeds.push({thetaIndex, rotation: azimuthIndex / 8 * TWO_PI});
    }
  });

  electricSeeds.forEach(() => {
    const array = new Float32Array(MAX_LINE_POINTS * 3);
    const geometry = new T.BufferGeometry();
    const attribute = new T.BufferAttribute(array, 3);
    if (attribute.setUsage && T.DynamicDrawUsage !== undefined) attribute.setUsage(T.DynamicDrawUsage);
    geometry.setAttribute('position', attribute);
    geometry.setDrawRange(0, 0);
    const line = new T.Line(geometry, electricMaterial);
    line.frustumCulled = false;
    electricGroup.add(line);
    electricLines.push({line, array});
  });

  const traceField = (seed, directionSign, sourcePhase) => {
    const points = [];
    let point = seed.clone();
    for (let i = 0; i < 86; i++) {
      const r = point.length();
      if (r < SOURCE_CUTOFF || r > FIELD_LIMIT) break;
      points.push(point.clone());
      const field = fieldAt(point, sourcePhase).E;
      const magnitude = field.length();
      if (!Number.isFinite(magnitude) || magnitude < 1e-7) break;
      const step = Math.min(0.17, 0.055 + r * 0.018);
      const firstDirection = field.multiplyScalar(directionSign / magnitude);
      const midpoint = point.clone().addScaledVector(firstDirection, step * 0.5);
      const midField = fieldAt(midpoint, sourcePhase).E;
      const midMagnitude = midField.length();
      if (!Number.isFinite(midMagnitude) || midMagnitude < 1e-7) break;
      point.addScaledVector(midField, directionSign * step / midMagnitude);
    }
    return points;
  };

  const updateElectricLines = () => {
    const baseLines = baseSeedDirections.map(seed => {
      const backward = traceField(seed, -1, phase).reverse();
      const forward = traceField(seed, 1, phase);
      return backward.concat(forward.slice(1)).slice(0, MAX_LINE_POINTS);
    });
    electricSeeds.forEach((seed, index) => {
      const points = baseLines[seed.thetaIndex].map(point => point.clone().applyAxisAngle(AXIS, seed.rotation));
      const {line, array} = electricLines[index];
      points.forEach((point, pointIndex) => {
        array[pointIndex * 3] = point.x;
        array[pointIndex * 3 + 1] = point.y;
        array[pointIndex * 3 + 2] = point.z;
      });
      line.geometry.setDrawRange(0, points.length);
      line.geometry.attributes.position.needsUpdate = true;
      line.visible = points.length > 2;
    });
  };

  // Magnetische Feldlinien: geschlossene azimutale Ringe -------------------
  // Die schwachen inneren Ringe zeigen das momentane Nahfeld an festen Orten.
  // Helle Ringe auf expandierenden Kugelschalen markieren dagegen gleiche
  // Phasen des retardierten B-Feldes und machen die Ausbreitung sichtbar.
  const magneticRings = [];
  const ringConfigs = [
    {rho: 0.48, y: 0}, {rho: 0.72, y: 0}, {rho: 0.98, y: 0}, {rho: 1.28, y: 0},
    {rho: 0.62, y: 0.72}, {rho: 0.62, y: -0.72}
  ];

  ringConfigs.forEach(config => {
    const points = [];
    for (let i = 0; i <= 72; i++) {
      const angle = i / 72 * TWO_PI;
      points.push(new T.Vector3(config.rho * Math.cos(angle), config.y, config.rho * Math.sin(angle)));
    }
    const material = new T.LineBasicMaterial({
      color: MAGNETIC_COLOR,
      transparent: true,
      opacity: 0.22,
      blending: T.AdditiveBlending,
      depthWrite: false
    });
    const line = new T.Line(new T.BufferGeometry().setFromPoints(points), material);
    line.frustumCulled = false;
    magneticGroup.add(line);
    const arrow = new T.ArrowHelper(new T.Vector3(0, 0, -1), new T.Vector3(config.rho, config.y, 0), 0.28, MAGNETIC_COLOR, 0.085, 0.05);
    magneticGroup.add(arrow);
    magneticRings.push({config, line, arrow});
  });

  const updateMagneticRings = () => {
    magneticRings.forEach(item => {
      const sample = new T.Vector3(item.config.rho, item.config.y, 0);
      const B = fieldAt(sample, phase).B;
      const magnitude = B.length();
      const visibility = clamp(Math.log1p(magnitude * 7) / 2.5, 0.025, 0.82);
      item.line.material.opacity = visibility;
      item.arrow.visible = visibility > 0.11 && magnitude > 1e-7;
      if (item.arrow.visible) {
        item.arrow.setDirection(B.normalize());
        item.arrow.setLength(0.18 + visibility * 0.34, 0.08, 0.05);
      }
    });
  };

  const magneticWaveShells = [];
  const createMagneticWaveShell = () => {
    const group = new T.Group();
    const rings = [];
    [42, 65, 90, 115, 138].forEach(degrees => {
      const theta = degrees * Math.PI / 180;
      const points = [];
      for (let i = 0; i <= 96; i++) {
        const phi = i / 96 * TWO_PI;
        points.push(new T.Vector3(
          Math.sin(theta) * Math.cos(phi),
          Math.cos(theta),
          Math.sin(theta) * Math.sin(phi)
        ));
      }
      const material = new T.LineBasicMaterial({
        color: MAGNETIC_COLOR,
        transparent: true,
        opacity: 0.54 * Math.sin(theta) ** 2,
        blending: T.AdditiveBlending,
        depthWrite: false
      });
      const line = new T.Line(new T.BufferGeometry().setFromPoints(points), material);
      line.frustumCulled = false;
      group.add(line);
      const arrows = [0, Math.PI].map(phi => {
        const n = new T.Vector3(
          Math.sin(theta) * Math.cos(phi),
          Math.cos(theta),
          Math.sin(theta) * Math.sin(phi)
        );
        const tangent = AXIS.clone().cross(n).normalize();
        const arrow = new T.ArrowHelper(tangent, n, 0.12, MAGNETIC_COLOR, 0.045, 0.028);
        group.add(arrow);
        return {arrow, phi};
      });
      rings.push({theta, line, arrows});
    });
    group.visible = false;
    magneticGroup.add(group);
    return {group, rings};
  };
  for (let i = 0; i < 4; i++) magneticWaveShells.push(createMagneticWaveShell());

  const updateMagneticWaveShells = radii => {
    magneticWaveShells.forEach((shell, shellIndex) => {
      const radius = radii[shellIndex];
      shell.group.visible = Boolean(radius);
      if (!radius) return;
      shell.group.scale.setScalar(radius);
      shell.rings.forEach(ring => {
        const sampleDirection = new T.Vector3(Math.sin(ring.theta), Math.cos(ring.theta), 0);
        const sampleField = fieldAt(sampleDirection.clone().multiplyScalar(radius), phase).B;
        const positiveTangent = AXIS.clone().cross(sampleDirection).normalize();
        const fieldSign = sampleField.dot(positiveTangent) >= 0 ? 1 : -1;
        const phaseVisibility = 0.32 + 0.68 * Math.tanh(sampleField.length() * radius * 6);
        ring.line.material.opacity = (0.18 + 0.46 * Math.sin(ring.theta) ** 2) * phaseVisibility;
        ring.arrows.forEach(item => {
          const phi = item.phi;
          const n = new T.Vector3(
            Math.sin(ring.theta) * Math.cos(phi),
            Math.cos(ring.theta),
            Math.sin(ring.theta) * Math.sin(phi)
          );
          item.arrow.setDirection(AXIS.clone().cross(n).normalize().multiplyScalar(fieldSign));
        });
      });
    });
  };

  // Berechnete Feldvektoren in der Strahlungszone --------------------------
  const farFieldVectors = [];
  for (let i = 0; i < 6; i++) {
    const phi = i / 6 * TWO_PI;
    const n = new T.Vector3(Math.cos(phi), 0, Math.sin(phi));
    const position = n.clone().multiplyScalar(4.45);
    const eArrow = new T.ArrowHelper(AXIS, position, 0.4, ELECTRIC_COLOR, 0.11, 0.065);
    const bArrow = new T.ArrowHelper(new T.Vector3(0, 0, 1), position, 0.4, MAGNETIC_COLOR, 0.11, 0.065);
    electricGroup.add(eArrow);
    magneticGroup.add(bArrow);
    farFieldVectors.push({position, eArrow, bArrow});
  }

  const updateFarFieldVectors = () => {
    farFieldVectors.forEach(item => {
      const field = fieldAt(item.position, phase);
      const eLength = clamp(Math.tanh(field.E.length() * 11) * 0.78, 0.03, 0.78);
      const bLength = clamp(Math.tanh(field.B.length() * 11) * 0.78, 0.03, 0.78);
      item.eArrow.visible = field.E.length() > 1e-5;
      item.bArrow.visible = field.B.length() > 1e-5;
      if (item.eArrow.visible) {
        item.eArrow.setDirection(field.E.clone().normalize());
        item.eArrow.setLength(eLength, 0.12, 0.075);
      }
      if (item.bArrow.visible) {
        item.bArrow.setDirection(field.B.clone().normalize());
        item.bArrow.setLength(bLength, 0.12, 0.075);
      }
    });
  };

  // Phasenfronten mit sin²(theta)-Richtungsverteilung ----------------------
  const fronts = [];
  const frontColors = [0x60a5fa, 0xa78bfa, 0x60a5fa, 0xa78bfa];
  const createUnitFront = frontIndex => {
    const group = new T.Group();
    [25, 45, 65, 90, 115, 135, 155].forEach(degrees => {
      const theta = degrees * Math.PI / 180;
      const points = [];
      for (let i = 0; i <= 96; i++) {
        const phi = i / 96 * TWO_PI;
        points.push(new T.Vector3(
          Math.sin(theta) * Math.cos(phi),
          Math.cos(theta),
          Math.sin(theta) * Math.sin(phi)
        ));
      }
      const pattern = Math.sin(theta) ** 2;
      const material = new T.LineBasicMaterial({
        color: frontColors[frontIndex % frontColors.length],
        transparent: true,
        opacity: 0.025 + 0.19 * pattern,
        blending: T.AdditiveBlending,
        depthWrite: false
      });
      group.add(new T.Line(new T.BufferGeometry().setFromPoints(points), material));
    });
    for (let j = 0; j < 6; j++) {
      const phi = j / 6 * Math.PI;
      const points = [];
      for (let i = 0; i <= 80; i++) {
        const theta = i / 80 * Math.PI;
        points.push(new T.Vector3(
          Math.sin(theta) * Math.cos(phi),
          Math.cos(theta),
          Math.sin(theta) * Math.sin(phi)
        ));
      }
      const material = new T.LineBasicMaterial({
        color: frontColors[frontIndex % frontColors.length],
        transparent: true,
        opacity: 0.07,
        blending: T.AdditiveBlending,
        depthWrite: false
      });
      group.add(new T.Line(new T.BufferGeometry().setFromPoints(points), material));
    }
    frontGroup.add(group);
    return group;
  };
  for (let i = 0; i < 4; i++) fronts.push(createUnitFront(i));

  const crestMaterial = new T.MeshBasicMaterial({color: ENERGY_COLOR});
  const crestMarker = new T.Mesh(new T.SphereGeometry(0.095, 16, 10), crestMaterial);
  frontGroup.add(crestMarker);
  const crestArrow = new T.ArrowHelper(new T.Vector3(1, 0, 0), new T.Vector3(), 0.62, ENERGY_COLOR, 0.14, 0.085);
  frontGroup.add(crestArrow);

  // Radialer Poynting-Vektor in der Fernzone -------------------------------
  const energyArrows = [];
  [45, 90, 135].forEach(degrees => {
    const theta = degrees * Math.PI / 180;
    for (let i = 0; i < 8; i++) {
      const phi = i / 8 * TWO_PI;
      const direction = new T.Vector3(
        Math.sin(theta) * Math.cos(phi),
        Math.cos(theta),
        Math.sin(theta) * Math.sin(phi)
      );
      const arrow = new T.ArrowHelper(direction, new T.Vector3(), 0.45, ENERGY_COLOR, 0.12, 0.075);
      energyGroup.add(arrow);
      energyArrows.push({theta, direction, arrow});
    }
  });

  let trackedRadius = 1;
  const updateWavefronts = () => {
    const wrappedHalfWave = ((phase % Math.PI) + Math.PI) % Math.PI;
    const radii = fronts.map((front, index) => {
      const radius = (wrappedHalfWave + index * Math.PI) / K;
      const valid = radius > 0.38 && radius < FIELD_LIMIT;
      front.visible = valid;
      if (valid) front.scale.setScalar(radius);
      return valid ? radius : null;
    });
    updateMagneticWaveShells(radii);

    const wrappedFullWave = ((phase % TWO_PI) + TWO_PI) % TWO_PI;
    trackedRadius = wrappedFullWave / K;
    const trackedVisible = trackedRadius > 0.45 && trackedRadius < FIELD_LIMIT;
    crestMarker.visible = trackedVisible;
    crestArrow.visible = trackedVisible;
    if (trackedVisible) {
      crestMarker.position.set(trackedRadius, 0, 0);
      crestArrow.position.set(Math.max(0.25, trackedRadius - 0.38), 0, 0);
    }

    const energyRadius = radii.find(radius => radius && radius > 2.1) || clamp(trackedRadius, 2.1, 5.8);
    energyArrows.forEach(item => {
      const retarded = phase - K * energyRadius;
      const directionalPattern = Math.sin(item.theta) ** 2;
      const instantaneousPower = directionalPattern * (0.18 + 0.82 * Math.cos(retarded) ** 2);
      item.arrow.position.copy(item.direction).multiplyScalar(energyRadius);
      item.arrow.setDirection(item.direction);
      item.arrow.setLength(0.15 + instantaneousPower * 0.52, 0.12, 0.075);
    });

    const trackText = trackedVisible
      ? `Wellenberg bei r = ${trackedRadius.toFixed(1)} · die hellen orangefarbenen B-Phasenringe laufen gemeinsam radial nach außen.`
      : 'Am Dipol entsteht gerade der nächste markierte Wellenberg.';
    const pausedTrackText = trackedVisible
      ? `Pausiert bei r = ${trackedRadius.toFixed(1)} · nach dem Start laufen die B-Phasenringe in Richtung ihrer Pfeile weiter.`
      : 'Pausiert · am Dipol liegt der Beginn der nächsten Feldphase.';
    $('#dipoleTrackLabel').textContent = running ? trackText : pausedTrackText;
    $('#dipoleFrontState').textContent = trackedVisible ? `bei r = ${trackedRadius.toFixed(1)} · nach außen` : 'neue Front entsteht am Sender';
  };

  const updateSource = () => {
    const dipoleMoment = Math.cos(phase);
    const electronDisplacement = -0.205 * dipoleMoment;
    const electronVelocity = 0.205 * OMEGA * Math.sin(phase);
    const velocityScale = Math.abs(electronVelocity) / (0.205 * OMEGA);

    electrons.forEach(item => {
      item.mesh.position.set(item.mesh.userData.x, item.mesh.userData.baseY + electronDisplacement, item.mesh.userData.z);
      const direction = electronVelocity >= 0 ? 1 : -1;
      const trailLength = 0.07 + velocityScale * 0.2;
      item.trailPositions[0] = item.mesh.position.x;
      item.trailPositions[1] = item.mesh.position.y - direction * trailLength;
      item.trailPositions[2] = item.mesh.position.z;
      item.trailPositions[3] = item.mesh.position.x;
      item.trailPositions[4] = item.mesh.position.y;
      item.trailPositions[5] = item.mesh.position.z;
      item.trail.geometry.attributes.position.needsUpdate = true;
      item.trail.visible = running && velocityScale > 0.08;
      item.arrow.position.copy(item.mesh.position);
      item.arrow.visible = (!running || vectorsForced) && velocityScale > 0.025;
      if (item.arrow.visible) {
        item.arrow.setDirection(electronVelocity >= 0 ? AXIS : AXIS.clone().multiplyScalar(-1));
        item.arrow.setLength(0.11 + velocityScale * 0.25, 0.075, 0.045);
      }
    });

    endCharges.forEach(charge => {
      const positiveHere = charge.userData.endSign * dipoleMoment > 0;
      charge.material.color.setHex(positiveHere ? 0xff6b6b : 0x5ac8fa);
      charge.material.opacity = 0.18 + 0.8 * Math.abs(dipoleMoment);
    });
    feedMaterial.opacity = 0.35 + 0.6 * Math.abs(Math.sin(phase));
    feedGlow.intensity = 0.4 + 1.5 * Math.abs(Math.sin(phase));

    if (Math.abs(dipoleMoment) < 0.13) $('#dipoleChargeState').textContent = 'nahezu ausgeglichen · Strom maximal';
    else $('#dipoleChargeState').textContent = dipoleMoment > 0 ? 'oben + · unten −' : 'oben − · unten +';

    if (velocityScale < 0.08) $('#dipoleMotionState').textContent = 'am Umkehrpunkt · v ≈ 0';
    else $('#dipoleMotionState').textContent = electronVelocity > 0 ? 'Elektronen nach oben ↑' : 'Elektronen nach unten ↓';
  };

  const updateLayerVisibility = () => {
    electricGroup.visible = layers.electric;
    magneticGroup.visible = layers.magnetic;
    frontGroup.visible = layers.fronts;
    energyGroup.visible = layers.energy;
    vectorGroup.visible = !running || vectorsForced;
  };

  const updateFields = () => {
    updateElectricLines();
    updateMagneticRings();
    updateFarFieldVectors();
  };

  // Bedienung --------------------------------------------------------------
  $('#dipolePlay').addEventListener('click', () => {
    running = !running;
    $('#dipolePlay').textContent = running ? '⏸ Pause' : '▶ Start';
    updateSource();
    updateLayerVisibility();
    updateWavefronts();
  });

  $('#dipoleSpeed').addEventListener('input', event => {
    speed = Number(event.target.value) / 100;
    $('#dipoleSpeedOut').textContent = `${speed.toFixed(1).replace('.', ',')} ×`;
  });

  $('#chargeVectors').addEventListener('click', event => {
    vectorsForced = !vectorsForced;
    event.currentTarget.classList.toggle('active', vectorsForced);
    event.currentTarget.setAttribute('aria-pressed', String(vectorsForced));
    event.currentTarget.textContent = vectorsForced ? 'Vektoren dauerhaft sichtbar' : 'Vektoren dauerhaft zeigen';
    updateSource();
    updateLayerVisibility();
  });

  $$('[data-dipole-layer]').forEach(button => button.addEventListener('click', () => {
    const layer = button.dataset.dipoleLayer;
    layers[layer] = !layers[layer];
    button.classList.toggle('active', layers[layer]);
    button.setAttribute('aria-pressed', String(layers[layer]));
    updateLayerVisibility();
  }));

  const resetView = () => {
    cameraState.yaw = 0.72;
    cameraState.pitch = 0.34;
    cameraState.radius = 10.8;
    updateCamera();
  };
  $('#dipoleResetView').addEventListener('click', resetView);

  let dragging = false;
  let pointerX = 0;
  let pointerY = 0;
  viewport.addEventListener('pointerdown', event => {
    dragging = true;
    pointerX = event.clientX;
    pointerY = event.clientY;
    viewport.classList.add('dragging');
    viewport.setPointerCapture(event.pointerId);
  });
  viewport.addEventListener('pointermove', event => {
    if (!dragging) return;
    const dx = event.clientX - pointerX;
    const dy = event.clientY - pointerY;
    pointerX = event.clientX;
    pointerY = event.clientY;
    cameraState.yaw -= dx * 0.007;
    cameraState.pitch = clamp(cameraState.pitch + dy * 0.006, -1.18, 1.18);
    updateCamera();
  });
  const endDrag = event => {
    dragging = false;
    viewport.classList.remove('dragging');
    if (event.pointerId !== undefined && viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
  };
  viewport.addEventListener('pointerup', endDrag);
  viewport.addEventListener('pointercancel', endDrag);
  viewport.addEventListener('wheel', event => {
    event.preventDefault();
    cameraState.radius = clamp(cameraState.radius * Math.exp(event.deltaY * 0.001), 6.2, 16);
    updateCamera();
  }, {passive: false});
  viewport.addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft') cameraState.yaw += 0.09;
    else if (event.key === 'ArrowRight') cameraState.yaw -= 0.09;
    else if (event.key === 'ArrowUp') cameraState.pitch = clamp(cameraState.pitch + 0.07, -1.18, 1.18);
    else if (event.key === 'ArrowDown') cameraState.pitch = clamp(cameraState.pitch - 0.07, -1.18, 1.18);
    else if (event.key === '+' || event.key === '=') cameraState.radius = clamp(cameraState.radius - 0.6, 6.2, 16);
    else if (event.key === '-') cameraState.radius = clamp(cameraState.radius + 0.6, 6.2, 16);
    else return;
    event.preventDefault();
    updateCamera();
  });

  $$('#dipoleCheckpoint [data-dipole-answer]').forEach(button => button.addEventListener('click', () => {
    const feedback = $('#dipoleCheckpoint .checkpoint-feedback');
    if (button.dataset.dipoleAnswer === '2') {
      $$('#dipoleCheckpoint [data-dipole-answer]').forEach(candidate => {
        candidate.disabled = true;
        candidate.classList.toggle('correct', candidate === button);
      });
      feedback.textContent = 'Richtig. Die Laufzeitverzögerung und der nach außen gerichtete Energiefluss unterscheiden Abstrahlung von einem bloßen gleichzeitigen Blinken.';
      feedback.className = 'checkpoint-feedback ok';
    } else {
      button.disabled = true;
      button.classList.add('wrong');
      feedback.textContent = 'Noch nicht. Suche nach einer Beobachtung, die sowohl eine Laufzeit als auch einen gerichteten Energietransport erkennen lässt.';
      feedback.className = 'checkpoint-feedback no';
    }
  }));

  const visibilityObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {if (entry.target === viewport) inView = entry.isIntersecting;});
  }, {rootMargin: '200px'});
  visibilityObserver.observe(viewport);

  const resize = () => {
    const width = Math.max(320, viewport.clientWidth);
    const height = Math.max(420, viewport.clientHeight);
    const pixelWidth = Math.round(width * renderer.getPixelRatio());
    const pixelHeight = Math.round(height * renderer.getPixelRatio());
    if (renderer.domElement.width !== pixelWidth || renderer.domElement.height !== pixelHeight) {
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }
  };

  const animate = now => {
    const dt = Math.min(0.05, Math.max(0, (now - lastFrame) / 1000));
    lastFrame = now;
    if (inView) {
      if (running) phase = (phase + dt * speed * OMEGA) % (TWO_PI * 120);
      updateSource();
      updateWavefronts();
      if (!running || now - lastFieldUpdate > 55) {
        updateFields();
        lastFieldUpdate = now;
      }
      updateLayerVisibility();
      resize();
      renderer.render(scene, camera);
    }
    requestAnimationFrame(animate);
  };

  updateSource();
  updateWavefronts();
  updateFields();
  updateLayerVisibility();
  resize();
  requestAnimationFrame(animate);
})();
