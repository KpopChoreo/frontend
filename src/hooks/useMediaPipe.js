import { useEffect, useRef, useState } from "react";
import { PoseLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import { drawOverlay } from "./useOverlay";

export const CURRENT_MODEL = "full";

const MODEL_CONFIGS = {
  lite: {
    label: "Lite",
    path: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
  },
  full: {
    label: "Full",
    path: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task",
  },
  heavy: {
    label: "Heavy",
    path: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task",
  },
};

const CANVAS_SIZE = 480;

export function useMediaPipe(videoRef, canvasRef) {
  const poseLandmarkerRef = useRef(null);
  const [landmarks, setLandmarks] = useState(null);
  const animFrameRef = useRef(null);
  const partsRef = useRef(null);

  const [fps, setFps] = useState(0);
  const fpsFrameCountRef = useRef(0);
  const fpsLastTimeRef = useRef(performance.now());

  useEffect(() => {
    const selectedModel = MODEL_CONFIGS[CURRENT_MODEL];

    const init = async () => {
      const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm"
      );

      poseLandmarkerRef.current = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: selectedModel.path,
          delegate: "CPU",
        },
        runningMode: "VIDEO",
        numPoses: 1,
      });

      detect();
    };

    const detect = () => {
      if (!videoRef.current || !canvasRef.current || !poseLandmarkerRef.current) {
        animFrameRef.current = requestAnimationFrame(detect);
        return;
      }

      const video = videoRef.current;
      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d");

      if (video.readyState < 2) {
        animFrameRef.current = requestAnimationFrame(detect);
        return;
      }

      // ── [수정] 중앙 크롭으로 정사각형 캔버스 ─────────────────
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      const cropSize = Math.min(vw, vh);       // 짧은 쪽 기준
      const offsetX = (vw - cropSize) / 2;     // 가로 중앙 크롭 시작점
      const offsetY = (vh - cropSize) / 2;     // 세로 중앙 크롭 시작점

      canvas.width = CANVAS_SIZE;
      canvas.height = CANVAS_SIZE;

      ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
      ctx.drawImage(video, offsetX, offsetY, cropSize, cropSize, 0, 0, CANVAS_SIZE, CANVAS_SIZE);
      // ─────────────────────────────────────────────────────────

      const result = poseLandmarkerRef.current.detectForVideo(video, performance.now());

      if (result.landmarks.length > 0) {
        const original = result.landmarks[0];
        const worldOriginal = result.worldLandmarks?.[0];

        // ── [수정] 크롭 비율에 맞게 x 좌표 범위 재계산 ──────────
        // 원본 x 좌표는 전체 영상 기준 (0~1)
        // 크롭 후 x 범위: offsetX/vw ~ (offsetX+cropSize)/vw
        const xMin = offsetX / vw;
        const xMax = (offsetX + cropSize) / vw;
        const yMin = offsetY / vh;
        const yMax = (offsetY + cropSize) / vh;

        const raw = original.map((lm, index) => {
          const vScore = lm.visibility ?? worldOriginal?.[index]?.visibility ?? 1.0;

          // 크롭 영역 밖으로 나가면 visibility 0
          const simulatedScore =
            lm.x < xMin || lm.x > xMax || lm.y < yMin || lm.y > yMax
              ? 0.0
              : vScore;

          // 크롭된 영역 기준으로 x, y 정규화
          const croppedX = (lm.x - xMin) / (xMax - xMin);
          const croppedY = (lm.y - yMin) / (yMax - yMin);

          return {
            x: 1 - croppedX, // 거울 반전
            y: croppedY,
            z: lm.z,
            visibility: simulatedScore,
          };
        });
        // ─────────────────────────────────────────────────────────

        setLandmarks(raw);

        // drawOverlay에 전달하는 original도 크롭 기준으로 변환
        const croppedOriginal = original.map((lm) => ({
          ...lm,
          x: (lm.x - xMin) / (xMax - xMin),
          y: (lm.y - yMin) / (yMax - yMin),
        }));

        drawOverlay(ctx, croppedOriginal, partsRef.current);
      }

      fpsFrameCountRef.current += 1;
      const now = performance.now();
      const elapsed = now - fpsLastTimeRef.current;
      if (elapsed >= 1000) {
        setFps(Math.round((fpsFrameCountRef.current * 1000) / elapsed));
        fpsFrameCountRef.current = 0;
        fpsLastTimeRef.current = now;
      }

      animFrameRef.current = requestAnimationFrame(detect);
    };

    init();

    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, []);

  return {
    landmarks,
    partsRef,
    fps,
    modelLabel: MODEL_CONFIGS[CURRENT_MODEL].label,
  };
}