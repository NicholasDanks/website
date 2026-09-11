/**
 * Strip anything executable from an SVG string before it is inserted with
 * innerHTML. The engines escape label text already (Graphviz and seminr's
 * SvgPlot both entity-encode), and construct names can come from the review
 * assistant's run_model code as well as from the user, so this is defence in
 * depth rather than the only barrier.
 */
export function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(xlink:)?href\s*=\s*("javascript:[^"]*"|'javascript:[^']*')/gi, "");
}
