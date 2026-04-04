import { prepare, layout } from "@chenglou/pretext";

const marginPx: Record<string, number> = { small: 16, medium: 32, large: 64 };

export function extractTextAndImageInfo(html: string): {
  text: string;
  imageCount: number;
  estimatedImageHeight: number;
} {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const text = doc.body.textContent || "";
  const images = doc.body.querySelectorAll("img");
  let estimatedImageHeight = 0;
  images.forEach((img) => {
    const w = img.getAttribute("width");
    const h = img.getAttribute("height");
    if (w && h) {
      estimatedImageHeight += parseInt(h) || 300;
    } else {
      estimatedImageHeight += 300;
    }
  });
  return { text, imageCount: images.length, estimatedImageHeight };
}

export function buildFontString(
  fontSize: number,
  fontFamily: string,
  fontWeight: number
): string {
  return `${fontWeight} ${fontSize}px ${fontFamily}`;
}

export function computeMaxWidth(
  containerWidth: number,
  margin: "small" | "medium" | "large",
  isPageFlip: boolean
): number {
  let effective = containerWidth;
  if (isPageFlip) {
    effective = Math.min(effective, 56 * 16);
  }
  return effective - 2 * (marginPx[margin] || 32);
}

export function predictPageCount(
  chapterTexts: string[],
  imageHeights: number[],
  font: string,
  maxWidth: number,
  lineHeightPx: number,
  pageHeight: number
): number {
  if (maxWidth <= 0 || pageHeight <= 0) return 1;
  let totalHeight = 0;
  for (let i = 0; i < chapterTexts.length; i++) {
    const t = chapterTexts[i].trim();
    if (t) {
      const prepared = prepare(t, font);
      const result = layout(prepared, maxWidth, lineHeightPx);
      totalHeight += result.height;
    }
    totalHeight += imageHeights[i] || 0;
    if (i < chapterTexts.length - 1) {
      totalHeight += 32; // chapter break spacing
    }
  }
  return Math.max(1, Math.ceil(totalHeight / pageHeight));
}
