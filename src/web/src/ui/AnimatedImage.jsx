import { useEffect, useRef } from 'preact/hooks';

const ANIMATED = /\.(gif|webp)(\?|$)/i;

export const isAnimated = (src) => ANIMATED.test(src || '');

/**
 * An image that can be paused: when `playing` is false an animated GIF/WebP shows its first frame
 * (drawn on a canvas), so pictures only move where the user wants them to.
 */
export function AnimatedImage({ src, playing = true, class: cls = '', alt = '' }) {
  const canvas = useRef(null);
  const still = isAnimated(src) && !playing;
  useEffect(() => {
    if (!still) return undefined;
    let alive = true;
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      const c = canvas.current;
      if (!alive || !c) return;
      c.width = img.naturalWidth || 1;
      c.height = img.naturalHeight || 1;
      c.getContext('2d').drawImage(img, 0, 0);
    };
    img.src = src;
    return () => { alive = false; };
  }, [src, still]);
  if (still) return <canvas ref={canvas} class={cls} aria-label={alt} />;
  return <img class={cls} src={src} alt={alt} draggable={false} />;
}
