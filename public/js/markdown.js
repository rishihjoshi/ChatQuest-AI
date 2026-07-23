/**
 * ChatQuest-AI — minimal markdown renderer for model output.
 *
 * SECURITY: model output is untrusted input. The single invariant this module
 * guarantees is ESCAPE FIRST, THEN FORMAT — every code path runs the raw text
 * through escapeHtml() before any tag is inserted, so the only markup that can
 * ever reach the DOM is the fixed set of tags written literally below.
 *
 * Kept separate from app.js so it can be unit-tested in Node without a DOM.
 * See test/unit/markdown.test.mjs.
 */

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function renderMarkdown(source) {
  if (!source) return '';

  // Split on fenced code blocks. An odd trailing fence means the model is still
  // mid-block, so the remainder renders as code rather than flashing as prose.
  const parts = source.split(/```/);
  let html = '';

  parts.forEach((part, index) => {
    if (index % 2 === 1) {
      const newline = part.indexOf('\n');
      const lang = newline === -1 ? '' : part.slice(0, newline).trim();
      const code = newline === -1 ? part : part.slice(newline + 1);
      html += `<pre class="code"${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`;
    } else {
      html += renderProse(part);
    }
  });

  return html;
}

function renderProse(text) {
  if (!text.trim()) return '';

  const lines = escapeHtml(text).split('\n');
  let html = '';
  let listTag = null;
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      html += `<p>${inline(paragraph.join('<br>'))}</p>`;
      paragraph = [];
    }
  };
  const closeList = () => {
    if (listTag) {
      html += `</${listTag}>`;
      listTag = null;
    }
  };

  for (const line of lines) {
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const heading = line.match(/^(#{1,4})\s+(.*)$/);

    if (bullet || numbered) {
      flushParagraph();
      const wanted = bullet ? 'ul' : 'ol';
      if (listTag !== wanted) {
        closeList();
        html += `<${wanted}>`;
        listTag = wanted;
      }
      html += `<li>${inline((bullet || numbered)[1])}</li>`;
    } else if (heading) {
      flushParagraph();
      closeList();
      const level = Math.min(heading[1].length + 2, 6);
      html += `<h${level}>${inline(heading[2])}</h${level}>`;
    } else if (!line.trim()) {
      flushParagraph();
      closeList();
    } else {
      closeList();
      paragraph.push(line);
    }
  }

  flushParagraph();
  closeList();
  return html;
}

/**
 * Inline formatting. Operates only on already-escaped text, so the capture
 * groups can never carry a `<` — the substitutions below are the only source
 * of markup here.
 */
function inline(text) {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, '$1<em>$2</em>');
}
