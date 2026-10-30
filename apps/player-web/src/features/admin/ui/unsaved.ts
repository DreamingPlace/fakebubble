/**
 * Part 24b-6, shared piece 5: a changed field is amber (#D9A441 border, #FDF6E6 fill) until it is saved, and the title row says
 * "n 处未保存". Callers set `data-dirty` on the control (or its wrapper); the CSS does the rest.
 */
export const markDirty = (node: Element, dirty: boolean) => {
  if (dirty) node.setAttribute?.('data-dirty', 'true');
  else node.removeAttribute?.('data-dirty');
};
export const unsavedText = (count: number) => `${count} 处未保存`;
