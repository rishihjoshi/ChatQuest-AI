/**
 * Unit tests for the model allow-list.
 *
 * These are invariants the UI and the proxy both depend on. They run offline —
 * scripts/verify-models.js is the separate check that the slugs actually exist
 * in OpenRouter's live catalogue.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { MODELS, MODEL_IDS, MAX_MODELS, DEFAULT_MODEL_IDS, getModel } from '../../public/js/models.js';

describe('allow-list shape', () => {
  test('every entry has the fields the UI renders', () => {
    for (const model of MODELS) {
      assert.equal(typeof model.id, 'string', `${model.id}: id`);
      assert.equal(typeof model.label, 'string', `${model.id}: label`);
      assert.equal(typeof model.provider, 'string', `${model.id}: provider`);
      assert.equal(typeof model.description, 'string', `${model.id}: description`);
      assert.ok(model.description.length > 10, `${model.id}: description is too short to be useful`);
    }
  });

  test('ids look like OpenRouter slugs', () => {
    for (const model of MODELS) {
      assert.match(model.id, /^[a-z0-9-]+\/[a-zA-Z0-9._-]+$/, `${model.id} is not a provider/model slug`);
    }
  });

  test('ids are unique', () => {
    assert.equal(new Set(MODELS.map((m) => m.id)).size, MODELS.length);
  });

  test('MODEL_IDS matches MODELS exactly', () => {
    // The proxy validates against MODEL_IDS; a drift here would let the picker
    // offer a model the server then rejects, or vice versa.
    assert.equal(MODEL_IDS.size, MODELS.length);
    for (const model of MODELS) assert.ok(MODEL_IDS.has(model.id));
  });

  test('the catalogue is curated, not the full OpenRouter list', () => {
    assert.ok(MODELS.length >= 6 && MODELS.length <= 8, `expected 6-8 models, got ${MODELS.length}`);
  });
});

describe('default selection', () => {
  test('defaults to exactly 3 models', () => {
    assert.equal(DEFAULT_MODEL_IDS.length, 3);
  });

  test('defaults are within the 1..MAX_MODELS cap', () => {
    assert.ok(DEFAULT_MODEL_IDS.length >= 1);
    assert.ok(DEFAULT_MODEL_IDS.length <= MAX_MODELS);
  });

  test('defaults span one OpenAI, one Anthropic and one Google model', () => {
    const providers = MODELS.filter((m) => m.default).map((m) => m.provider).sort();
    assert.deepEqual(providers, ['Anthropic', 'Google', 'OpenAI']);
  });

  test('every default id is on the allow-list', () => {
    for (const id of DEFAULT_MODEL_IDS) assert.ok(MODEL_IDS.has(id), `${id} is not on the allow-list`);
  });
});

describe('cap and lookup', () => {
  test('the cap is 4', () => {
    assert.equal(MAX_MODELS, 4);
  });

  test('there are more models available than the cap allows at once', () => {
    assert.ok(MODELS.length > MAX_MODELS, 'the cap should actually constrain the picker');
  });

  test('getModel resolves a known id and rejects an unknown one', () => {
    assert.equal(getModel(MODELS[0].id).id, MODELS[0].id);
    assert.equal(getModel('evil/not-real'), undefined);
    assert.equal(getModel(''), undefined);
  });

  test('providers are spread across at least three vendors', () => {
    assert.ok(new Set(MODELS.map((m) => m.provider)).size >= 3);
  });
});
