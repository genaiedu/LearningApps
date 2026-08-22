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
  const smoothstep = (edge0, edge1, value) => {
    const amount = clamp((value - edge0) / (edge1 - edge0), 0, 1);
    return amount * amount * (3 - 2 * amount);
  };
  const TWO_PI = Math.PI * 2;
  const AXIS = new T.Vector3(0, 1, 0);
  const C_MODEL = 1;
  const OMEGA = 1.05;
  const K = OMEGA / C_MODEL;
  const SOURCE_CUTOFF = 0.42;
  const FIELD_LIMIT = 5.8;
  const FIELDLINE_RADIAL_SAMPLES = 250;
  const FIELDLINE_LEVELS = [-0.62, -0.36, -0.17, -0.065, 0.065, 0.17, 0.36, 0.62];
  const MERIDIAN_COPIES = 6;
  const MAX_ELECTRIC_CURVES = 18;
  const MAX_ELECTRIC_POINTS = FIELDLINE_RADIAL_SAMPLES * 2 + 8;
  const MAGNETIC_RADIAL_CANDIDATES = 32;
  const MAGNETIC_DENSITY_THRESHOLDS = [0.08, 0.58, 0.32, 0.82, 0.2, 0.7, 0.45, 0.94];
  // Gleiche Quantile von integral sin(theta) dtheta: dichter am Aequator,
  // wo das B-Feld des Dipols staerker ist, und duenner an der Dipolachse.
  const MAGNETIC_RING_ANGLES = [36.87, 66.42, 90, 113.58, 143.13];
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
  const cameraState = {yaw: 0.72, pitch: 0.34, radius: 12.4};
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

  const layers = {
    electric: true,
    magnetic: true,
    fronts: false,
    energy: true
  };
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
  const rodGeometry = new T.CylinderGeometry(0.08, 0.08, 0.52, 24);
  const topRod = new T.Mesh(rodGeometry, metalMaterial);
  const bottomRod = new T.Mesh(rodGeometry, metalMaterial);
  topRod.position.y = 0.32;
  bottomRod.position.y = -0.32;
  sourceGroup.add(topRod, bottomRod);

  const feedMaterial = new T.MeshBasicMaterial({color: 0xffd166, transparent: true, opacity: 0.82});
  const feed = new T.Mesh(new T.SphereGeometry(0.085, 18, 12), feedMaterial);
  sourceGroup.add(feed);
  const feedGlow = new T.PointLight(0xffb84d, 1.1, 3.2);
  sourceGroup.add(feedGlow);
  const sourceAccelerationArrow = new T.ArrowHelper(
    AXIS,
    new T.Vector3(0.2, 0, 0),
    0.36,
    CHARGE_COLOR,
    0.13,
    0.075
  );
  sourceGroup.add(sourceAccelerationArrow);

  const ionMaterial = new T.MeshBasicMaterial({color: 0x9aa8ba, transparent: true, opacity: 0.48});
  const ionGeometry = new T.SphereGeometry(0.022, 8, 6);
  [-1, 1].forEach(sign => {
    for (let i = 0; i < 16; i++) {
      const ion = new T.Mesh(ionGeometry, ionMaterial);
      const angle = i * 2.399;
      ion.position.set(0.05 * Math.cos(angle), sign * (0.09 + (i % 8) * 0.06), 0.05 * Math.sin(angle));
      sourceGroup.add(ion);
    }
  });

  const electronGeometry = new T.SphereGeometry(0.048, 16, 12);
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
      electron.userData.baseY = sign * (0.11 + i * 0.07);
      electron.userData.x = 0.038 * Math.cos(angle);
      electron.userData.z = 0.038 * Math.sin(angle);
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
  const chargeGeometry = new T.SphereGeometry(0.032, 12, 8);
  [-1, 1].forEach(sign => {
    for (let i = 0; i < 10; i++) {
      const material = new T.MeshBasicMaterial({color: 0xff6b6b, transparent: true, opacity: 0.7});
      const charge = new T.Mesh(chargeGeometry, material);
      const angle = i / 10 * TWO_PI;
      charge.position.set(0.11 * Math.cos(angle), sign * 0.61, 0.11 * Math.sin(angle));
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

  // Elektrische Feldlinien der vollständigen retardierten Dipollösung ------
  // Für das rotationssymmetrische Dipolfeld ist
  //   Psi(r,theta) = sin²(theta) [p(t-r/c)/r + p'(t-r/c)/c]
  // eine Stromfunktion. Ihre Niveaulinien sind daher exakte momentane
  // E-Feldlinien außerhalb des ausgeblendeten Quellkerns. Geschlossene
  // Niveaulinien sind die abgelösten Strahlungsschleifen; an der inneren
  // Grenze endende Kurven bleiben mit dem Dipol verbunden.
  const electricFluxAtRadius = (radius, sourcePhase) => {
    const retardedPhase = sourcePhase - K * radius;
    return Math.cos(retardedPhase) / radius - OMEGA * Math.sin(retardedPhase) / C_MODEL;
  };

  const fluxLevelIsVisible = (level, radius, sourcePhase) => {
    const flux = electricFluxAtRadius(radius, sourcePhase);
    if (Math.abs(flux) < 1e-8) return false;
    const ratio = level / flux;
    return ratio > 0 && ratio <= 1;
  };

  const refineFluxBoundary = (level, leftRadius, rightRadius, sourcePhase) => {
    let left = leftRadius;
    let right = rightRadius;
    let leftValue = electricFluxAtRadius(left, sourcePhase) - level;
    for (let i = 0; i < 14; i++) {
      const middle = (left + right) * 0.5;
      const middleValue = electricFluxAtRadius(middle, sourcePhase) - level;
      if (leftValue * middleValue <= 0) {
        right = middle;
      } else {
        left = middle;
        leftValue = middleValue;
      }
    }
    return (left + right) * 0.5;
  };

  const branchPointsFor = (radii, level, sourcePhase, lowerHalf = false) => radii.map(radius => {
    const ratio = clamp(level / electricFluxAtRadius(radius, sourcePhase), 0, 1);
    const theta = Math.asin(Math.sqrt(ratio));
    const signedTheta = lowerHalf ? Math.PI - theta : theta;
    return new T.Vector3(radius * Math.sin(signedTheta), radius * Math.cos(signedTheta), 0);
  });

  const buildElectricFieldCurves = sourcePhase => {
    const minRadius = SOURCE_CUTOFF * 1.025;
    const radii = Array.from({length: FIELDLINE_RADIAL_SAMPLES + 1}, (_, index) =>
      minRadius + index / FIELDLINE_RADIAL_SAMPLES * (FIELD_LIMIT - minRadius)
    );
    const curves = [];

    FIELDLINE_LEVELS.forEach(level => {
      const visible = radii.map(radius => fluxLevelIsVisible(level, radius, sourcePhase));
      let startIndex = null;
      for (let index = 0; index <= visible.length; index++) {
        if (visible[index] && startIndex === null) startIndex = index;
        if ((index === visible.length || !visible[index]) && startIndex !== null) {
          const endIndex = index - 1;
          if (endIndex - startIndex >= 3) {
            const touchesSource = startIndex === 0;
            const touchesBoundary = endIndex === radii.length - 1;
            const startRadius = touchesSource
              ? radii[startIndex]
              : refineFluxBoundary(level, radii[startIndex - 1], radii[startIndex], sourcePhase);
            const endRadius = touchesBoundary
              ? radii[endIndex]
              : refineFluxBoundary(level, radii[endIndex], radii[endIndex + 1], sourcePhase);
            const segmentRadii = [startRadius];
            for (let sampleIndex = startIndex; sampleIndex <= endIndex; sampleIndex++) {
              const radius = radii[sampleIndex];
              if (radius > startRadius + 1e-5 && radius < endRadius - 1e-5) segmentRadii.push(radius);
            }
            segmentRadii.push(endRadius);

            const upper = branchPointsFor(segmentRadii, level, sourcePhase, false);
            const lower = branchPointsFor(segmentRadii, level, sourcePhase, true);
            if (!touchesBoundary) {
              const points = upper.concat(lower.reverse().slice(1));
              curves.push({points, kind: touchesSource ? 'source' : 'closed'});
            } else if (!touchesSource) {
              const points = upper.reverse().concat(lower.slice(1));
              curves.push({points, kind: 'outgoing'});
            } else {
              curves.push({points: upper, kind: 'outgoing'});
              curves.push({points: lower, kind: 'outgoing'});
            }
          }
          startIndex = null;
        }
      }
    });
    return curves
      .sort((first, second) => {
        const priority = {source: 0, closed: 1, outgoing: 2};
        return priority[first.kind] - priority[second.kind];
      })
      .slice(0, MAX_ELECTRIC_CURVES);
  };

  const electricCurveObjects = Array.from({length: MAX_ELECTRIC_CURVES}, () =>
    Array.from({length: MERIDIAN_COPIES}, (_, copyIndex) => {
      const array = new Float32Array(MAX_ELECTRIC_POINTS * 3);
      const geometry = new T.BufferGeometry();
      const attribute = new T.BufferAttribute(array, 3);
      if (attribute.setUsage && T.DynamicDrawUsage !== undefined) attribute.setUsage(T.DynamicDrawUsage);
      geometry.setAttribute('position', attribute);
      geometry.setDrawRange(0, 0);
      const material = new T.LineBasicMaterial({
        color: ELECTRIC_COLOR,
        transparent: true,
        opacity: 0.5,
        blending: T.AdditiveBlending,
        depthWrite: false
      });
      const line = new T.Line(geometry, material);
      line.frustumCulled = false;
      const arrow = new T.ArrowHelper(AXIS, new T.Vector3(), 0.17, ELECTRIC_COLOR, 0.052, 0.032);
      arrow.line.material.transparent = true;
      arrow.line.material.opacity = 0.78;
      arrow.cone.material.transparent = true;
      arrow.cone.material.opacity = 0.78;
      line.visible = false;
      arrow.visible = false;
      electricGroup.add(line, arrow);
      return {line, arrow, array, phi: copyIndex / MERIDIAN_COPIES * TWO_PI};
    })
  );

  const updateElectricLines = () => {
    const curves = buildElectricFieldCurves(phase);
    electricCurveObjects.forEach((copies, curveIndex) => {
      const curve = curves[curveIndex];
      copies.forEach(copy => {
        if (!curve || curve.points.length < 4) {
          copy.line.visible = false;
          copy.arrow.visible = false;
          return;
        }
        const pointCount = Math.min(curve.points.length, MAX_ELECTRIC_POINTS);
        const cosPhi = Math.cos(copy.phi);
        const sinPhi = Math.sin(copy.phi);
        for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
          const point = curve.points[pointIndex];
          copy.array[pointIndex * 3] = point.x * cosPhi;
          copy.array[pointIndex * 3 + 1] = point.y;
          copy.array[pointIndex * 3 + 2] = point.x * sinPhi;
        }
        copy.line.geometry.setDrawRange(0, pointCount);
        copy.line.geometry.attributes.position.needsUpdate = true;
        copy.line.material.opacity = curve.kind === 'closed' ? 0.62 : curve.kind === 'source' ? 0.5 : 0.34;
        copy.line.visible = true;

        const arrowIndex = clamp(Math.floor(pointCount * 0.34), 1, pointCount - 2);
        const basePoint = curve.points[arrowIndex];
        const arrowPoint = new T.Vector3(basePoint.x * cosPhi, basePoint.y, basePoint.x * sinPhi);
        const electricDirection = fieldAt(arrowPoint, phase).E;
        copy.arrow.visible = electricDirection.length() > 1e-7;
        if (copy.arrow.visible) {
          copy.arrow.position.copy(arrowPoint);
          copy.arrow.setDirection(electricDirection.normalize());
          copy.arrow.setLength(curve.kind === 'closed' ? 0.2 : 0.17, 0.052, 0.032);
        }
      });
    });
  };

  // Magnetische Feldlinien derselben retardierten Lösung ------------------
  // B ist beim elektrischen Dipol rein azimutal. Jede dargestellte Kurve ist
  // daher ein echter geschlossener Kreis um die Dipolachse. Ein feines Raster
  // moeglicher Kreisradien bleibt geometrisch fest und unsichtbar. Aus |B|
  // wird bestimmt, wie viele benachbarte Kreise weich sichtbar werden. So
  // wandert die Dichtezone nach aussen, ohne dass einzelne Kreise ihren Radius
  // aendern. Richtung und Dichte stammen aus demselben retardierten Feld wie E.
  const unitMagneticRingPoints = Array.from({length: 97}, (_, index) => {
    const angle = index / 96 * TWO_PI;
    return new T.Vector3(Math.cos(angle), 0, Math.sin(angle));
  });
  const unitMagneticRingGeometry = new T.BufferGeometry().setFromPoints(unitMagneticRingPoints);
  const magneticMinRadius = SOURCE_CUTOFF * 1.08;
  const magneticRingObjects = Array.from({length: MAGNETIC_RADIAL_CANDIDATES}, (_, radialIndex) => {
    const radius = magneticMinRadius + (radialIndex + 0.5) / MAGNETIC_RADIAL_CANDIDATES * (FIELD_LIMIT - magneticMinRadius);
    const densityThreshold = MAGNETIC_DENSITY_THRESHOLDS[radialIndex % MAGNETIC_DENSITY_THRESHOLDS.length];
    return MAGNETIC_RING_ANGLES.map((degrees, angleIndex) => {
      const theta = degrees * Math.PI / 180;
      const rho = radius * Math.sin(theta);
      const y = radius * Math.cos(theta);
      const material = new T.LineBasicMaterial({
        color: MAGNETIC_COLOR,
        transparent: true,
        opacity: 0,
        blending: T.AdditiveBlending,
        depthWrite: false
      });
      const line = new T.Line(unitMagneticRingGeometry, material);
      line.position.set(0, y, 0);
      line.scale.set(rho, 1, rho);
      line.frustumCulled = false;
      const arrow = angleIndex === radialIndex % MAGNETIC_RING_ANGLES.length
        ? new T.ArrowHelper(new T.Vector3(0, 0, -1), new T.Vector3(rho, y, 0), 0.18, MAGNETIC_COLOR, 0.055, 0.034)
        : null;
      if (arrow) {
        arrow.line.material.transparent = true;
        arrow.cone.material.transparent = true;
        arrow.visible = false;
      }
      line.visible = false;
      magneticGroup.add(line);
      if (arrow) magneticGroup.add(arrow);
      return {radius, densityThreshold, theta, line, arrow};
    });
  });

  const updateMagneticRings = () => {
    magneticRingObjects.forEach(rings => {
      const {radius, densityThreshold} = rings[0];
      const equatorialField = fieldAt(new T.Vector3(radius, 0, 0), phase).B;
      const fluxDensity = equatorialField.length() * radius;
      const visibleDensity = clamp(Math.pow(fluxDensity / 1.05, 1.6), 0, 1);
      const membership = smoothstep(densityThreshold - 0.11, densityThreshold + 0.11, visibleDensity);
      rings.forEach(item => {
        const rho = item.radius * Math.sin(item.theta);
        const y = item.radius * Math.cos(item.theta);
        const samplePoint = new T.Vector3(rho, y, 0);
        const magneticField = fieldAt(samplePoint, phase).B;
        const strength = clamp(Math.tanh(magneticField.length() * item.radius * 1.8), 0, 1);
        const opacity = membership * (0.08 + 0.5 * Math.sqrt(strength));
        item.line.material.opacity = opacity;
        item.line.visible = opacity > 0.018;
        if (item.arrow) item.arrow.visible = item.line.visible && opacity > 0.12 && magneticField.length() > 1e-7;
        if (item.arrow?.visible) {
          item.arrow.position.copy(samplePoint);
          item.arrow.setDirection(magneticField.normalize());
          item.arrow.setLength(0.12 + 0.18 * strength, 0.055, 0.034);
          item.arrow.line.material.opacity = membership * (0.35 + 0.6 * strength);
          item.arrow.cone.material.opacity = membership * (0.35 + 0.6 * strength);
        }
      });
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
  const crestEArrow = new T.ArrowHelper(AXIS, new T.Vector3(), 0.66, ELECTRIC_COLOR, 0.13, 0.075);
  const crestBArrow = new T.ArrowHelper(new T.Vector3(0, 0, -1), new T.Vector3(), 0.66, MAGNETIC_COLOR, 0.13, 0.075);
  const crestArrow = new T.ArrowHelper(new T.Vector3(1, 0, 0), new T.Vector3(), 0.66, ENERGY_COLOR, 0.14, 0.085);
  electricGroup.add(crestEArrow);
  magneticGroup.add(crestBArrow);
  energyGroup.add(crestArrow);
  const retardationPositions = new Float32Array(6);
  const retardationGeometry = new T.BufferGeometry();
  retardationGeometry.setAttribute('position', new T.BufferAttribute(retardationPositions, 3));
  const retardationMaterial = new T.LineDashedMaterial({
    color: 0xfde68a,
    transparent: true,
    opacity: 0.45,
    dashSize: 0.16,
    gapSize: 0.11,
    depthWrite: false
  });
  const retardationLine = new T.Line(retardationGeometry, retardationMaterial);
  frontGroup.add(retardationLine);

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
    const wrappedFullWave = ((phase % TWO_PI) + TWO_PI) % TWO_PI;
    trackedRadius = wrappedFullWave / K;
    const trackedVisible = trackedRadius > 0.45 && trackedRadius < FIELD_LIMIT;
    crestMarker.visible = trackedVisible;
    crestEArrow.visible = trackedVisible;
    crestBArrow.visible = trackedVisible;
    crestArrow.visible = trackedVisible;
    retardationLine.visible = trackedVisible;
    if (trackedVisible) {
      const crestPosition = new T.Vector3(trackedRadius, 0, 0);
      const crestField = fieldAt(crestPosition, phase);
      crestMarker.position.copy(crestPosition);
      crestEArrow.position.copy(crestPosition);
      crestBArrow.position.copy(crestPosition);
      crestArrow.position.copy(crestPosition);
      if (crestField.E.length() > 1e-7) crestEArrow.setDirection(crestField.E.clone().normalize());
      if (crestField.B.length() > 1e-7) crestBArrow.setDirection(crestField.B.clone().normalize());
      crestArrow.setDirection(crestPosition.clone().normalize());
      retardationPositions[0] = 0;
      retardationPositions[1] = 0;
      retardationPositions[2] = 0;
      retardationPositions[3] = trackedRadius;
      retardationPositions[4] = 0;
      retardationPositions[5] = 0;
      retardationGeometry.attributes.position.needsUpdate = true;
      retardationLine.computeLineDistances();
    }

    energyArrows.forEach(item => {
      item.arrow.visible = trackedVisible;
      if (!trackedVisible) return;
      const retarded = phase - K * trackedRadius;
      const directionalPattern = Math.sin(item.theta) ** 2;
      const instantaneousPower = directionalPattern * (0.18 + 0.82 * Math.cos(retarded) ** 2);
      item.arrow.position.copy(item.direction).multiplyScalar(trackedRadius);
      item.arrow.setDirection(item.direction);
      item.arrow.setLength(0.15 + instantaneousPower * 0.52, 0.12, 0.075);
    });

    const trackText = trackedVisible
      ? `Eine gemeinsame Phase: E (blau), B (orange) und Energiefluss (gelb) bei r = ${trackedRadius.toFixed(1)} · alle laufen mit demselben c nach außen.`
      : 'Am Dipol entsteht gerade der nächste markierte Wellenberg.';
    const pausedTrackText = trackedVisible
      ? `Pausiert bei r = ${trackedRadius.toFixed(1)} · E, B und Energiefluss gehören hier zu derselben ausgesandten Phase.`
      : 'Pausiert · am Dipol liegt der Beginn der nächsten Feldphase.';
    $('#dipoleTrackLabel').textContent = running ? trackText : pausedTrackText;
    $('#dipoleFrontState').textContent = trackedVisible ? `E + B + S gemeinsam bei r = ${trackedRadius.toFixed(1)}` : 'neue gekoppelte Front entsteht';
    if (trackedVisible) {
      const emissionPhase = phase - K * trackedRadius;
      const emissionMoment = Math.cos(emissionPhase);
      const emissionState = emissionMoment >= 0 ? 'oben + · unten −' : 'oben − · unten +';
      const emissionAcceleration = emissionMoment >= 0 ? 'Elektronen-a ↑' : 'Elektronen-a ↓';
      $('#dipoleRetardedState').textContent = `vor Δt = r/c = ${trackedRadius.toFixed(1)}: ${emissionAcceleration}, ${emissionState}`;
    } else {
      $('#dipoleRetardedState').textContent = 'noch kein Laufzeitabstand zum Sender';
    }
  };

  const updateSource = () => {
    const dipoleMoment = Math.cos(phase);
    const electronDisplacement = -0.055 * dipoleMoment;
    const electronVelocity = 0.055 * OMEGA * Math.sin(phase);
    const electronAcceleration = 0.055 * OMEGA * OMEGA * Math.cos(phase);
    const velocityScale = Math.abs(electronVelocity) / (0.055 * OMEGA);
    const accelerationScale = Math.abs(electronAcceleration) / (0.055 * OMEGA * OMEGA);

    electrons.forEach(item => {
      item.mesh.position.set(item.mesh.userData.x, item.mesh.userData.baseY + electronDisplacement, item.mesh.userData.z);
      const direction = electronVelocity >= 0 ? 1 : -1;
      const trailLength = 0.035 + velocityScale * 0.09;
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
        item.arrow.setLength(0.08 + velocityScale * 0.18, 0.065, 0.04);
      }
    });

    endCharges.forEach(charge => {
      const positiveHere = charge.userData.endSign * dipoleMoment > 0;
      charge.material.color.setHex(positiveHere ? 0xff6b6b : 0x5ac8fa);
      charge.material.opacity = 0.18 + 0.8 * Math.abs(dipoleMoment);
    });
    feedMaterial.opacity = 0.35 + 0.6 * Math.abs(Math.sin(phase));
    feedGlow.intensity = 0.4 + 1.5 * Math.abs(Math.sin(phase));
    sourceAccelerationArrow.visible = accelerationScale > 0.045;
    if (sourceAccelerationArrow.visible) {
      sourceAccelerationArrow.setDirection(electronAcceleration >= 0 ? AXIS : AXIS.clone().multiplyScalar(-1));
      sourceAccelerationArrow.setLength(0.12 + accelerationScale * 0.32, 0.1, 0.06);
    }

    if (Math.abs(dipoleMoment) < 0.13) $('#dipoleChargeState').textContent = 'nahezu ausgeglichen · Strom maximal';
    else $('#dipoleChargeState').textContent = dipoleMoment > 0 ? 'oben + · unten −' : 'oben − · unten +';

    if (velocityScale < 0.08) $('#dipoleMotionState').textContent = 'am Umkehrpunkt · v ≈ 0';
    else $('#dipoleMotionState').textContent = electronVelocity > 0 ? 'Elektronen nach oben ↑' : 'Elektronen nach unten ↓';

    if (accelerationScale < 0.08) $('#dipoleAccelerationState').textContent = 'a ≈ 0 · Strahlungsantrieb momentan klein';
    else $('#dipoleAccelerationState').textContent = electronAcceleration > 0
      ? 'a nach oben ↑ · violetter Pfeil'
      : 'a nach unten ↓ · violetter Pfeil';
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
    cameraState.radius = 12.4;
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
    cameraState.radius = clamp(cameraState.radius * Math.exp(event.deltaY * 0.001), 6.2, 18);
    updateCamera();
  }, {passive: false});
  viewport.addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft') cameraState.yaw += 0.09;
    else if (event.key === 'ArrowRight') cameraState.yaw -= 0.09;
    else if (event.key === 'ArrowUp') cameraState.pitch = clamp(cameraState.pitch + 0.07, -1.18, 1.18);
    else if (event.key === 'ArrowDown') cameraState.pitch = clamp(cameraState.pitch - 0.07, -1.18, 1.18);
    else if (event.key === '+' || event.key === '=') cameraState.radius = clamp(cameraState.radius - 0.6, 6.2, 18);
    else if (event.key === '-') cameraState.radius = clamp(cameraState.radius + 0.6, 6.2, 18);
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
