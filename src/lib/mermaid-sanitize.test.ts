// @vitest-environment jsdom
/**
 * Unit tests for defense-in-depth mermaid SVG sanitization.
 *
 * These tests verify that DOMPurify.sanitize(svg, { FORCE_BODY: true }) —
 * the same call used in PlanViewerDialog.tsx — strips XSS payloads while
 * preserving legitimate SVG structure produced by mermaid.
 */
import { describe, expect, it } from 'vitest';
import DOMPurify from 'dompurify';

/** Replicate the exact call used in PlanViewerDialog. */
function sanitizeMermaidSvg(svg: string): string {
  return DOMPurify.sanitize(svg, { FORCE_BODY: true });
}

describe('mermaid SVG sanitization (defense-in-depth)', () => {
  it('preserves a clean mermaid-style SVG unchanged', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50">
      <g class="nodes">
        <rect x="10" y="10" width="30" height="20" fill="#4c8" />
        <text x="25" y="25" text-anchor="middle">A</text>
      </g>
    </svg>`;
    const result = sanitizeMermaidSvg(svg);
    expect(result).toContain('<svg');
    expect(result).toContain('<rect');
    expect(result).toContain('<text');
  });

  it('strips inline event handlers (onclick)', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
      <rect onclick="alert(1)" x="0" y="0" width="10" height="10" />
    </svg>`;
    const result = sanitizeMermaidSvg(svg);
    expect(result).not.toContain('onclick');
    expect(result).not.toContain('alert');
    // The rect itself should still be present (just sanitized)
    expect(result).toContain('<rect');
  });

  it('strips onerror event handler on image element', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
      <image href="x" onerror="alert('xss')" />
    </svg>`;
    const result = sanitizeMermaidSvg(svg);
    expect(result).not.toContain('onerror');
    expect(result).not.toContain("alert('xss')");
  });

  it('strips <script> tags inside SVG', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
      <script>alert('xss')</script>
      <rect x="0" y="0" width="10" height="10" />
    </svg>`;
    const result = sanitizeMermaidSvg(svg);
    expect(result).not.toContain('<script');
    expect(result).not.toContain("alert('xss')");
    expect(result).toContain('<rect');
  });

  it('strips javascript: href on anchor element', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
      <a href="javascript:alert(1)"><rect x="0" y="0" width="10" height="10" /></a>
    </svg>`;
    const result = sanitizeMermaidSvg(svg);
    expect(result).not.toContain('javascript:');
  });

  it('strips onload attribute', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">
      <rect x="0" y="0" width="10" height="10" />
    </svg>`;
    const result = sanitizeMermaidSvg(svg);
    expect(result).not.toContain('onload');
  });

  it('preserves mermaid flowchart SVG structure with markers and paths', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">
      <defs>
        <marker id="arrowhead" markerWidth="10" markerHeight="7" orient="auto">
          <polygon points="0 0, 10 3.5, 0 7" fill="#888" />
        </marker>
      </defs>
      <g class="edgePaths">
        <path d="M10,50 L190,50" marker-end="url(#arrowhead)" stroke="#888" />
      </g>
      <g class="nodes">
        <rect class="node" x="10" y="10" width="60" height="30" rx="4" />
        <text x="40" y="30" dominant-baseline="middle" text-anchor="middle">Start</text>
      </g>
    </svg>`;
    const result = sanitizeMermaidSvg(svg);
    expect(result).toContain('<svg');
    expect(result).toContain('<defs');
    expect(result).toContain('<marker');
    expect(result).toContain('<path');
    expect(result).toContain('<rect');
    expect(result).toContain('Start');
  });
});
