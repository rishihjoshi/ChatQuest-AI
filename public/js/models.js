/**
 * ChatQuest-AI — curated model allow-list.
 *
 * SINGLE SOURCE OF TRUTH. This file is imported by BOTH:
 *   - the browser (public/js/app.js) to build the picker, and
 *   - the serverless proxy (api/chat.js) to validate the incoming `model` field.
 *
 * Keep it dependency-free and free of any browser or Node globals so both
 * runtimes can import it unchanged.
 *
 * Editing the catalogue: add/remove entries below. IDs must be valid OpenRouter
 * model slugs — see https://openrouter.ai/models. Anything not listed here is
 * rejected by the proxy with a 400 before it ever reaches OpenRouter.
 */

export const MAX_MODELS = 4;

export const MODELS = [
  {
    id: 'openai/gpt-5.6-sol',
    label: 'ChatGPT — GPT-5.6 Sol',
    provider: 'OpenAI',
    description: 'OpenAI flagship. Strongest general reasoning, slower and priciest of the trio.',
    default: true,
  },
  {
    id: 'openai/gpt-5.4-mini',
    label: 'ChatGPT — GPT-5.4 Mini',
    provider: 'OpenAI',
    description: 'Cheap, quick OpenAI model. Good for drafting and everyday questions.',
  },
  {
    id: 'anthropic/claude-sonnet-5',
    label: 'Claude — Sonnet 5',
    provider: 'Anthropic',
    description: 'Anthropic workhorse. Excellent at long-form writing, code and instructions.',
    default: true,
  },
  {
    id: 'anthropic/claude-haiku-4.5',
    label: 'Claude — Haiku 4.5',
    provider: 'Anthropic',
    description: 'Fastest Claude. Near-instant first token, well suited to short answers.',
  },
  {
    id: 'google/gemini-3.6-flash',
    label: 'Gemini — 3.6 Flash',
    provider: 'Google',
    description: 'Google’s fast multimodal model with a very large context window.',
    default: true,
  },
  {
    id: 'google/gemini-3.1-pro-preview',
    label: 'Gemini — 3.1 Pro (preview)',
    provider: 'Google',
    description: 'Google’s top-end reasoning model. Preview channel — may change without notice.',
  },
  {
    id: 'deepseek/deepseek-v3.2',
    label: 'DeepSeek — V3.2',
    provider: 'DeepSeek',
    description: 'Open-weight and very cheap. A useful sanity check against the frontier labs.',
  },
  {
    id: 'meta-llama/llama-3.3-70b-instruct',
    label: 'Llama — 3.3 70B Instruct',
    provider: 'Meta',
    description: 'Open-weight Meta model. Lowest cost per token in this list.',
  },
];

/** Set of allowed model IDs — used by the proxy for O(1) allow-list checks. */
export const MODEL_IDS = new Set(MODELS.map((m) => m.id));

/** IDs pre-checked on first load: one OpenAI, one Anthropic, one Google. */
export const DEFAULT_MODEL_IDS = MODELS.filter((m) => m.default).map((m) => m.id);

/** Look up a model entry by ID, or undefined if it is not on the allow-list. */
export function getModel(id) {
  return MODELS.find((m) => m.id === id);
}
