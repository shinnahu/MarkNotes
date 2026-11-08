import { useEffect, useRef } from 'preact/hooks';
import { CanvasBoard } from '../boards/canvas.js';

/** Hosts the canvas board (plain DOM in a shadow root, see boards/canvas.js). */
export default function CanvasView({ docKey }) {
  const host = useRef(null);
  useEffect(() => {
    const board = new CanvasBoard(host.current, docKey);
    return () => board.destroy();
  }, [docKey]);
  return <div class="cv-host" ref={host} />;
}
