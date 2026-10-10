export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Rect that a `contentWidth x contentHeight` image occupies when fitted inside
 * a container with `object-fit: contain` semantics. Used to map between image
 * pixels and on-screen pixels for the crop handles.
 */
export function containRect(
  containerWidth: number,
  containerHeight: number,
  contentWidth: number,
  contentHeight: number,
): Rect {
  if (containerWidth <= 0 || containerHeight <= 0 || contentWidth <= 0 || contentHeight <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const scale = Math.min(containerWidth / contentWidth, containerHeight / contentHeight);
  const width = contentWidth * scale;
  const height = contentHeight * scale;
  return {
    x: (containerWidth - width) / 2,
    y: (containerHeight - height) / 2,
    width,
    height,
  };
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
