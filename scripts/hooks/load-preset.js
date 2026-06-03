#!/usr/bin/env node
'use strict';

/**
 * load-preset.js — Resolve and load the active harness preset.
 * @version 0.10.0
 *
 * Resolution order (first match wins):
 *   1. process.env.HARNESS_PRESET
 *   2. <root>/.harness.local.json `preset` field
 *   3. <root>/.claude/settings.json `harness.preset` field
 *   4. "generic" (default)
 *
 * If the resolved preset directory is missing (e.g. user wrote `company` but
 * `presets/company/` was never vendored locally), falls back to `generic` and
 * sets `fallback: true` on the returned object.
 *
 * Module export:
 *   const { loadPreset } = require('./load-preset');
 *   const p = loadPreset();
 *   p.commit_format.subject_regex   // active commit format regex (or undefined)
 *   p.branch_policy.protected_branches  // active protected list (or [])
 *
 * CLI:
 *   node scripts/hooks/load-preset.js          # prints active preset JSON
 *   HARNESS_PRESET=example-company node ...    # override
 */

const fs = require('fs');
const path = require('path');
const findRoot = require('./find-root');

function safeReadJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function resolvePresetName(root) {
  if (process.env.HARNESS_PRESET) {
    return { name: process.env.HARNESS_PRESET, source: 'env HARNESS_PRESET' };
  }
  const local = safeReadJson(path.join(root, '.harness.local.json'));
  if (local && local.preset) {
    return { name: local.preset, source: '.harness.local.json' };
  }
  const settings = safeReadJson(path.join(root, '.claude', 'settings.json'));
  if (settings && settings.harness && settings.harness.preset) {
    return { name: settings.harness.preset, source: '.claude/settings.json' };
  }
  return { name: 'generic', source: 'default' };
}

function loadPresetByName(root, name, _seen) {
  const seen = _seen || new Set();
  if (seen.has(name)) return null; // cycle protection
  seen.add(name);

  const presetDir = path.join(root, 'presets', name);
  if (!fs.existsSync(presetDir)) return null;

  const manifest = safeReadJson(path.join(presetDir, 'manifest.json'));
  if (!manifest) return null;

  const out = {
    name,
    dir: presetDir,
    manifest,
    commit_format: {},
    branch_policy: {},
  };

  // Apply parent (extends) first, this preset's files override
  if (manifest.extends) {
    const base = loadPresetByName(root, manifest.extends, seen);
    if (base) {
      out.commit_format = { ...base.commit_format };
      out.branch_policy = { ...base.branch_policy };
    }
  }

  const files = manifest.files || {};
  const cf = safeReadJson(path.join(presetDir, files.commit_format || 'commit-format.json'));
  const bp = safeReadJson(path.join(presetDir, files.branch_policy || 'branch-policy.json'));
  if (cf) out.commit_format = { ...out.commit_format, ...cf };
  if (bp) out.branch_policy = { ...out.branch_policy, ...bp };

  return out;
}

function loadPreset() {
  const root = findRoot();
  const { name: requested, source } = resolvePresetName(root);
  const loaded = loadPresetByName(root, requested);
  if (loaded) {
    return Object.assign(loaded, { fallback: false, requested, source, root });
  }
  // Requested preset not found → fall back to generic
  const fallback = loadPresetByName(root, 'generic');
  if (fallback) {
    return Object.assign(fallback, {
      fallback: true,
      requested,
      source,
      root,
      warning: `Preset '${requested}' (from ${source}) not found at presets/${requested}/. Falling back to 'generic'.`,
    });
  }
  // Even generic missing — return empty stub
  return {
    name: 'none',
    dir: null,
    manifest: { name: 'none' },
    commit_format: {},
    branch_policy: {},
    fallback: true,
    requested,
    source,
    root,
    warning: `No preset found at all (requested '${requested}', generic also missing).`,
  };
}

module.exports = { loadPreset, resolvePresetName, loadPresetByName };

// CLI mode for diagnostics
if (require.main === module) {
  const preset = loadPreset();
  if (preset.warning) {
    process.stderr.write(`[load-preset] ${preset.warning}\n`);
  }
  process.stdout.write(JSON.stringify(preset, null, 2) + '\n');
}
