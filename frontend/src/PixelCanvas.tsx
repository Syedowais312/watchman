import { useEffect, useRef } from 'react';
import { startRenderer, type RendererHandle } from './renderer';

interface Props {
  onSelect: (key: string | null) => void;
  selected: string | null;
  showKubeSystem: boolean;
}

/**
 * Mounts the canvas once and hands it to the rAF renderer.
 *
 * This component has no state and no dependency on live data, so it never
 * re-renders while traffic is flowing. Selection and the kube-system toggle are
 * pushed into the renderer imperatively rather than through a re-render.
 */
export function PixelCanvas({ onSelect, selected, showKubeSystem }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const handleRef = useRef<RendererHandle | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    const handle = startRenderer(canvasRef.current);
    handleRef.current = handle;
    return () => handle.stop();
  }, []);

  useEffect(() => {
    handleRef.current?.setSelected(selected);
  }, [selected]);

  useEffect(() => {
    handleRef.current?.setShowKubeSystem(showKubeSystem);
  }, [showKubeSystem]);

  const onClick = (ev: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const handle = handleRef.current;
    if (!canvas || !handle) return;
    const rect = canvas.getBoundingClientRect();
    onSelect(handle.hitTest(ev.clientX - rect.left, ev.clientY - rect.top));
  };

  const onMove = (ev: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    handleRef.current?.setHover(ev.clientX - rect.left, ev.clientY - rect.top);
  };

  return (
    <canvas
      ref={canvasRef}
      className="pixel-canvas"
      onClick={onClick}
      onMouseMove={onMove}
      onMouseLeave={() => handleRef.current?.setHover(-1, -1)}
    />
  );
}
