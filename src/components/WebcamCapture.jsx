import { useRef, useEffect, useState, useCallback } from "react";
import { useMediaPipe } from "../hooks/useMediaPipe";
import fixWebmDuration from "fix-webm-duration";

const BASE_URL = "http://localhost:8000";
const WS_URL = "ws://localhost:8000";
const WINDOW_SIZE = 5;

function WebcamCapture({ song, onFinish }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const referenceVideoRef = useRef(null);
  const wsRef = useRef(null);
  const windowBufferRef = useRef([]);
  const frameIdxRef = useRef(0);
  const isAnalyzingRef = useRef(false);

  // ── [추가] 녹화 관련 ref ────────────────────────────────────
  const mediaRecorderRef = useRef(null);
  const recordedChunksRef = useRef([]);
  const recordStartTimeRef = useRef(0); // 녹화 시작 시간 기록용
  // ─────────────────────────────────────────────────────────────

  const [phase, setPhase] = useState("idle");
  const [countdown, setCountdown] = useState(null);
  const [error, setError] = useState(null);
  const [score, setScore] = useState(null);
  const [parts, setParts] = useState(null);
  const [videoUrl, setVideoUrl] = useState(null);
  const [frameCount, setFrameCount] = useState(0);

  const { landmarks, partsRef, fps, modelLabel } = useMediaPipe(videoRef, canvasRef);

  // ── 1. 댄스 준비 ────────────────────────────────────────────
  useEffect(() => {
    if (!song?.dance_id) return;
    const readyDance = async () => {
      try {
        const res = await fetch(`${BASE_URL}/dances/${song.dance_id}/ready`);
        if (!res.ok) throw new Error("댄스 준비 실패");
        const data = await res.json();
        setVideoUrl(`${BASE_URL}${data.video_url}`);
      } catch (err) {
        setError(err.message);
      }
    };
    readyDance();
  }, [song]);

  // ── 2. 관절 수집 + WebSocket 전송 (practicing만) ────────────
  useEffect(() => {
    if (phase !== "practicing" || !landmarks) return;

    const currentTime = referenceVideoRef.current?.currentTime ?? 0;
    const frame = {
      frame_idx: frameIdxRef.current,
      timestamp: currentTime,
      landmarks: landmarks.map((lm) => ({
        x: lm.x, y: lm.y, z: lm.z, visibility: lm.visibility,
      })),
    };

    frameIdxRef.current++;
    if (frameIdxRef.current % 30 === 0) {
      setFrameCount(frameIdxRef.current);
    }

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      windowBufferRef.current.push(frame);
      if (windowBufferRef.current.length >= WINDOW_SIZE) {
        wsRef.current.send(JSON.stringify({
          window: windowBufferRef.current,
          current_timestamp: currentTime,
        }));
        windowBufferRef.current = [];
      }
    }
  }, [landmarks, phase]);

  // ── 3. 웹캠 (항상 ON) ───────────────────────────────────────
  useEffect(() => {
    const startWebcam = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480 },
        });
        if (videoRef.current) videoRef.current.srcObject = stream;
      } catch {
        setError("웹캠을 찾을 수 없습니다.");
      }
    };
    startWebcam();
    return () => videoRef.current?.srcObject?.getTracks().forEach((t) => t.stop());
  }, []);

  // ── 4. DTW 분석 (영상 파일 전송) ────────────────────────────
  const runDtwAnalysis = useCallback(async (videoBlob) => {
    if (isAnalyzingRef.current) return;
    isAnalyzingRef.current = true;
    setPhase("analyzing");
    setError(null);

    try {
      const formData = new FormData();
      formData.append("dance_id", song.dance_id);
      formData.append("user_video", videoBlob, "user_video.webm");
      formData.append("top_n", "3");

      const res = await fetch(`${BASE_URL}/api/v1/dtw/analyze`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData?.detail?.message || `HTTP ${res.status}`);
      }

      const result = await res.json();
      onFinish(result);
    } catch (err) {
      console.error("DTW 분석 오류:", err);
      setError(`분석 오류: ${err.message}`);
      setPhase("practicing");
    } finally {
      isAnalyzingRef.current = false;
    }
  }, [song, onFinish]);

  // ── 5. 녹화 시작 ────────────────────────────────────────────
  const startRecording = useCallback(() => {
    const stream = videoRef.current?.srcObject;
    if (!stream) return;

    recordedChunksRef.current = [];

    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
      ? "video/webm;codecs=vp9"
      : "video/webm";

    const mediaRecorder = new MediaRecorder(stream, { mimeType });
    mediaRecorderRef.current = mediaRecorder;

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunksRef.current.push(e.data);
    };

    mediaRecorder.onstop = () => {
      // 1. 원본 Blob 생성
      const rawBlob = new Blob(recordedChunksRef.current, { type: "video/webm" });
      
      // 2. 실제 녹화된 시간(duration) 계산
      const duration = Date.now() - recordStartTimeRef.current;
      
      // 3. 메타데이터 주입 후 분석 서버로 전송
      fixWebmDuration(rawBlob, duration, (fixedBlob) => {
        console.log(`원본 크기: ${rawBlob.size} bytes, 수정된 크기: ${fixedBlob.size} bytes`);
        runDtwAnalysis(fixedBlob); // 수정된 Blob을 전송!
      });
    };

    mediaRecorder.start(); // 1초마다 데이터 수집
    recordStartTimeRef.current = Date.now(); // 녹화 시작 시간 저장
    console.log("녹화 시작");
  }, [runDtwAnalysis]);

  // ── 6. 녹화 종료 ────────────────────────────────────────────
  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
      console.log("녹화 종료");
    }
  }, []);

  // ── 7. 카운트다운 함수 ───────────────────────────────────────
  const startCountdown = useCallback(() => {
    setCountdown(3);
    let count = 3;
    const timer = setInterval(() => {
      count -= 1;
      if (count === 0) {
        clearInterval(timer);
        setCountdown(null);
        setPhase("practicing");
        const vid = referenceVideoRef.current;
        if (vid) {
          vid.currentTime = 0;
          vid.play().catch((e) => console.error("영상 재생 실패:", e));
        }
        startRecording(); 
      } else {
        setCountdown(count);
      }
    }, 1000);
  }, [startRecording]);

  // ── 8. 시작 버튼 → WebSocket 연결 완료 후 카운트다운 ─────────
  const handleStart = () => {
    frameIdxRef.current = 0;
    windowBufferRef.current = [];
    recordedChunksRef.current = [];
    setFrameCount(0);
    setScore(null);
    setParts(null);
    partsRef.current = null;
    setError(null);
    setPhase("countdown");

    const ws = new WebSocket(`${WS_URL}/ws/similarity/${song.dance_id}`);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("WebSocket 연결됨 → 카운트다운 시작");
      startCountdown();
    };
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.error) { console.error("서버 에러:", data.error); return; }
      if (data.similarity !== null) {
        setScore(Math.round(data.similarity * 100));
        setParts(data.parts);
        partsRef.current = data.parts;
      }
    };
    ws.onerror = (err) => console.error("WebSocket 오류:", err);
    ws.onclose = () => console.log("WebSocket 종료");
  };

  // cleanup
  useEffect(() => {
    return () => {
      wsRef.current?.close();
      partsRef.current = null;
      if (mediaRecorderRef.current?.state === "recording") {
        mediaRecorderRef.current.stop();
      }
    };
  }, []);

  // ── 9. 영상 종료 → 자동 DTW ──────────────────────────────────
  const handleVideoEnded = useCallback(() => {
    if (phase === "practicing") {
      stopRecording(); 
    }
  }, [phase, stopRecording]);

  // ── 10. 수동 종료 ────────────────────────────────────────────
  const handleManualStop = () => {
    referenceVideoRef.current?.pause();
    stopRecording(); 
  };

  // ── 헬퍼 ────────────────────────────────────────────────────
  const getScoreColor = (s) => {
    if (s >= 80) return "#16a34a";
    if (s >= 50) return "#F1A519";
    return "#dc2626";
  };
  const partLabel = (key) => ({
    left_arm: "왼팔", right_arm: "오른팔",
    left_leg: "왼다리", right_leg: "오른다리",
  }[key] ?? key);

  return (
    <div style={{ color: "#3b1f6e", padding: "10px 20px" }}>

      {/* 에러 */}
      {error && (
        <p style={{ color: "red", textAlign: "center", marginBottom: "8px" }}>
          ⚠️ {error}
        </p>
      )}

      {/* 실시간 점수 */}
      {phase === "practicing" && (
        score !== null ? (
          <div style={{ textAlign: "center", margin: "8px 0" }}>
            <p style={{ color: getScoreColor(score), fontSize: "28px", fontWeight: "bold", margin: 0 }}>
              유사도: {score}점
            </p>
            {parts && (
              <div style={{ display: "flex", gap: "12px", justifyContent: "center", marginTop: "8px" }}>
                {Object.entries(parts).map(([part, value]) => (
                  <div key={part} style={{
                    padding: "4px 10px",
                    background: getScoreColor(Math.round(value * 100)),
                    borderRadius: "6px", fontSize: "12px", fontWeight: "bold", color: "white",
                  }}>
                    {partLabel(part)}: {Math.round(value * 100)}점
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <p style={{ color: "gray", textAlign: "center", margin: "8px 0" }}>⏳ 연결 중...</p>
        )
      )}

      {/* DTW 분석 중 */}
      {phase === "analyzing" && (
        <div style={{
          textAlign: "center", margin: "12px 0", padding: "14px 24px",
          background: "linear-gradient(135deg, #f3e8ff, #fce7f3)",
          borderRadius: "12px", border: "1px solid #e9d5ff",
        }}>
          <p style={{ fontSize: "18px", fontWeight: "bold", color: "#7c3aed", margin: "0 0 4px" }}>
            🔄 종합 분석 중...
          </p>
          <p style={{ color: "#a855f7", fontSize: "13px", margin: 0 }}>
            영상을 분석하고 있습니다. 잠시만 기다려주세요 (최대 120초)
          </p>
        </div>
      )}

      {/* 영상 + 웹캠 */}
      <div style={{ display: "flex", gap: "12px", justifyContent: "center" }}>

        {/* 정답 안무 */}
        <div style={{ width: "480px" }}>
          <p style={{ textAlign: "center", color: "gray", marginBottom: "6px", fontSize: "13px" }}>
            🎬 정답 안무
          </p>
          <div style={{ position: "relative", width: "480px", height: "480px", borderRadius: "10px", overflow: "hidden" }}>
            <video
              ref={referenceVideoRef}
              src={videoUrl}
              onEnded={handleVideoEnded}
              style={{
                width: "480px", height: "480px",
                background: "#000", objectFit: "contain", display: "block",
              }}
            />
            {(phase === "idle" || phase === "countdown") && (
              <div style={{
                position: "absolute", inset: 0, background: "#1a1a2e",
                display: "flex", flexDirection: "column",
                alignItems: "center", justifyContent: "center", gap: "10px",
              }}>
                <span style={{ fontSize: "52px" }}>🎬</span>
                <p style={{ color: "#a855f7", fontSize: "14px", margin: 0 }}>
                  {phase === "countdown" ? "잠시 후 시작됩니다..." : "시작 버튼을 눌러 연습을 시작하세요"}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* 내 동작 */}
        <div style={{ width: "480px" }}>
          <p style={{ textAlign: "center", color: "gray", marginBottom: "6px", fontSize: "13px" }}>
            🎥 내 동작
            {phase === "idle" && (
              <span style={{ color: "#22c55e", marginLeft: "8px", fontSize: "11px" }}>● 웹캠 대기 중</span>
            )}
            {phase === "practicing" && (
              <span style={{ color: "#ef4444", marginLeft: "8px", fontSize: "11px" }}>● 녹화 중</span>
            )}
          </p>
          <div style={{
            position: "relative", width: "480px", height: "480px",
            overflow: "hidden", borderRadius: "10px",
          }}>
            <video
              ref={videoRef}
              autoPlay
              playsInline
              style={{
                position: "absolute", width: "480px", height: "480px",
                objectFit: "cover", background: "#000", transform: "scaleX(-1)",
              }}
            />
            <canvas
              ref={canvasRef}
              style={{
                position: "absolute", width: "480px", height: "480px",
                transform: "scaleX(-1)",
              }}
            />

            {/* FPS + 모델명 오버레이 */}
            <div style={{
              position: "absolute", top: "10px", left: "10px",
              background: "rgba(0,0,0,0.55)",
              borderRadius: "8px", padding: "6px 12px",
              display: "flex", gap: "12px", alignItems: "center",
            }}>
              <span style={{ color: "#22c55e", fontSize: "13px", fontWeight: "700" }}>
                {fps} FPS
              </span>
              <span style={{ color: "#a855f7", fontSize: "12px", fontWeight: "600" }}>
                MediaPipe {modelLabel}
              </span>
            </div>

            {/* 카운트다운 오버레이 */}
            {phase === "countdown" && countdown !== null && (
              <div style={{
                position: "absolute", inset: 0,
                background: "rgba(0,0,0,0.5)",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <span style={{
                  fontSize: "120px",
                  fontWeight: "900",
                  color: "white",
                  textShadow: "0 0 30px rgba(168,85,247,0.8)",
                }}>
                  {countdown}
                </span>
              </div>
            )}

            {/* 연결 대기 오버레이 */}
            {phase === "countdown" && countdown === null && (
              <div style={{
                position: "absolute", inset: 0,
                background: "rgba(0,0,0,0.5)",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <p style={{ color: "white", fontSize: "14px", fontWeight: "600" }}>⏳ 연결 중...</p>
              </div>
            )}

            {phase === "idle" && (
              <div style={{
                position: "absolute", inset: 0,
                background: "rgba(0,0,0,0.3)",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <p style={{ color: "white", fontSize: "14px", fontWeight: "600" }}>⏸ 대기 중</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 하단 버튼 */}
      <div style={{
        textAlign: "center", marginTop: "20px",
        display: "flex", gap: "16px", justifyContent: "center", alignItems: "center",
      }}>
        {(phase === "idle" || phase === "countdown") && (
          <button
            onClick={handleStart}
            disabled={!videoUrl || phase === "countdown"}
            style={{
              padding: "14px 64px", fontSize: "17px", fontWeight: "700",
              borderRadius: "14px", border: "none",
              cursor: (!videoUrl || phase === "countdown") ? "not-allowed" : "pointer",
              background: (!videoUrl || phase === "countdown")
                ? "#d1d5db"
                : "linear-gradient(135deg, #a855f7, #ec4899)",
              color: "white",
              boxShadow: (!videoUrl || phase === "countdown") ? "none" : "0 6px 20px rgba(168,85,247,0.4)",
              transition: "all 0.2s",
            }}
          >
            {phase === "countdown" ? `${countdown ?? ""}초 후 시작...` : "▶ 시작"}
          </button>
        )}

        {phase === "practicing" && (
          <>
            <button
              onClick={handleManualStop}
              style={{
                padding: "12px 40px", fontSize: "15px", fontWeight: "700",
                borderRadius: "14px", border: "none", cursor: "pointer",
                background: "linear-gradient(135deg, #ef4444, #f97316)",
                color: "white",
                boxShadow: "0 4px 14px rgba(239,68,68,0.35)",
                transition: "all 0.2s",
              }}
            >
              ⏹ 종료 및 분석
            </button>
            <p style={{ color: "#a855f7", fontSize: "12px", margin: 0 }}>
              수집 프레임: {frameCount}
            </p>
          </>
        )}

        {phase === "analyzing" && (
          <button disabled style={{
            padding: "14px 64px", fontSize: "17px", fontWeight: "700",
            borderRadius: "14px", border: "none", cursor: "not-allowed",
            background: "#d1d5db", color: "white",
          }}>
            🔄 분석 중...
          </button>
        )}
      </div>

    </div>
  );
}

export default WebcamCapture;