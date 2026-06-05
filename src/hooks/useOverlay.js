import { PoseLandmarker, DrawingUtils } from "@mediapipe/tasks-vision";

// 부위별 관절 인덱스
const BODY_PART_INDICES = {
  left_arm:  [11, 13, 15, 17, 19, 21],
  right_arm: [12, 14, 16, 18, 20, 22],
  left_leg:  [23, 25, 27, 29, 31],
  right_leg: [24, 26, 28, 30, 32],
};

// 부위별 연결선 정의
const BODY_PART_CONNECTIONS = {
  left_arm:  [[11,13],[13,15],[15,17],[15,19],[15,21],[17,19],[19,21]],
  right_arm: [[12,14],[14,16],[16,18],[16,20],[16,22],[18,20],[20,22]],
  left_leg:  [[23,25],[25,27],[27,29],[27,31],[29,31]],
  right_leg: [[24,26],[26,28],[28,30],[28,32],[30,32]],
};

// 몸통 연결선 (흰색 고정)
const TORSO_CONNECTIONS = [
  [11, 12], [11, 23], [12, 24], [23, 24]
];

function getColorByScore(score) {
  if (score === null || score === undefined) return "#ef4444";
  const s = Math.round(score * 100);
  if (s >= 80) return "#22c55e";
  if (s >= 50) return "#F1A519";
  return "#ef4444";
}

function getLabelByScore(score) {
  if (score === null || score === undefined) return "Bad";
  const s = Math.round(score * 100);
  if (s >= 80) return "Perfect";
  if (s >= 50) return "Good";
  return "Bad";
}

function getPartCenter(original, indices, canvasWidth, canvasHeight) {
  const validLms = indices
    .map((i) => original[i])
    .filter((lm) => lm && lm.x > 0.03 && lm.x < 0.97 && lm.y > 0.03 && lm.y < 0.97);

  if (validLms.length === 0) return null;

  const avgX = validLms.reduce((sum, lm) => sum + lm.x, 0) / validLms.length;
  const avgY = validLms.reduce((sum, lm) => sum + lm.y, 0) / validLms.length;

  return {
    x: avgX * canvasWidth,
    y: avgY * canvasHeight,
  };
}

function drawLine(ctx, lmA, lmB, W, H, color, lineWidth) {
  if (!lmA || !lmB) return;
  if (lmA.x < 0.03 || lmA.x > 0.97 || lmA.y < 0.03 || lmA.y > 0.97) return;
  if (lmB.x < 0.03 || lmB.x > 0.97 || lmB.y < 0.03 || lmB.y > 0.97) return;

  ctx.beginPath();
  ctx.moveTo(lmA.x * W, lmA.y * H);
  ctx.lineTo(lmB.x * W, lmB.y * H);
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = "round";
  ctx.stroke();
}

export function drawOverlay(ctx, original, parts) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;

  // ── 1. 몸통 연결선 (흰색 고정) ───────────────────────────────
  for (const [i, j] of TORSO_CONNECTIONS) {
    drawLine(ctx, original[i], original[j], W, H, "#FFFFFF80", 3);
  }

  // ── 2. 부위별 연결선 (점수에 따른 색상) ──────────────────────
  for (const [part, connections] of Object.entries(BODY_PART_CONNECTIONS)) {
    const score = parts?.[part] ?? null;
    const color = getColorByScore(score);

    for (const [i, j] of connections) {
      drawLine(ctx, original[i], original[j], W, H, color, 4);
    }
  }

  // ── 3. 관절 점 (부위별 색상) ─────────────────────────────────
  const bodyPartAllIndices = new Set(Object.values(BODY_PART_INDICES).flat());

  original.forEach((lm, i) => {
    if (!lm || lm.x < 0.03 || lm.x > 0.97 || lm.y < 0.03 || lm.y > 0.97) return;

    let color = "#94a3b8"; // 기본 회색 (얼굴/몸통)
    if (bodyPartAllIndices.has(i)) {
      for (const [part, indices] of Object.entries(BODY_PART_INDICES)) {
        if (indices.includes(i)) {
          color = getColorByScore(parts?.[part] ?? null);
          break;
        }
      }
    }

    ctx.beginPath();
    ctx.arc(lm.x * W, lm.y * H, 4, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = "white";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  });

  // ── 4. 텍스트 (Perfect/Good/Bad) ─────────────────────────────
  if (parts) {
    for (const [part, indices] of Object.entries(BODY_PART_INDICES)) {
      const score = parts[part];
      const textColor = getColorByScore(score);
      const label = getLabelByScore(score);

      const center = getPartCenter(original, indices, W, H);
      if (!center) continue;

      ctx.save();
      ctx.scale(-1, 1);
      ctx.translate(-W, 0);

      const mirroredX = W - center.x;
      const fontSize = Math.max(14, W * 0.028);
      ctx.font = `bold ${fontSize}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      const textWidth = ctx.measureText(label).width;
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.beginPath();
      ctx.roundRect(
        mirroredX - textWidth / 2 - 6,
        center.y - fontSize / 2 - 4,
        textWidth + 12,
        fontSize + 8,
        6
      );
      ctx.fill();

      ctx.fillStyle = textColor;
      ctx.fillText(label, mirroredX, center.y);
      ctx.restore();
    }
  }
}