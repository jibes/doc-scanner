<script lang="ts">
  import type { BinarizeMethod } from '../lib/imaging/binarize';
  import type { ScanSettings } from '../lib/imaging/pipeline';
  import type { RGBAImage } from '../lib/imaging/types';
  import { PRESETS, type PresetId } from '../lib/presets';
  import CanvasView from './CanvasView.svelte';
  import Slider from './Slider.svelte';

  interface Props {
    preview: RGBAImage | null;
    original: RGBAImage | null;
    settings: ScanSettings;
    presetId: PresetId | null;
    processing: boolean;
    onSettingsChange: () => void;
    onPreset: (id: PresetId) => void;
    onRecrop: () => void;
    onSave: () => void;
    onUpload: () => void;
  }

  let {
    preview,
    original,
    settings,
    presetId,
    processing,
    onSettingsChange,
    onPreset,
    onRecrop,
    onSave,
    onUpload,
  }: Props = $props();

  let comparing = $state(false);
  let advanced = $state(false);

  const shown = $derived(comparing && original ? original : preview);

  const METHODS: { value: BinarizeMethod; label: string }[] = [
    { value: 'sauvola', label: 'Sauvola (local, recommended)' },
    { value: 'adaptive', label: 'Adaptive Gaussian' },
    { value: 'niblack', label: 'Niblack' },
    { value: 'wolf', label: 'Wolf' },
    { value: 'otsu', label: 'Otsu (global)' },
    { value: 'off', label: 'Off (no binarisation)' },
  ];

  // A higher threshold sensitivity `k` thins strokes, so the "boldness" the user
  // sees runs the other way: 0 is the thinnest k, 100 the boldest.
  const K_MIN = 0.05;
  const K_MAX = 0.4;
  const toBoldness = (k: number) => Math.round(((K_MAX - k) / (K_MAX - K_MIN)) * 100);
  const fromBoldness = (b: number) => +(K_MAX - (b / 100) * (K_MAX - K_MIN)).toFixed(4);

  function update(mutate: () => void) {
    mutate();
    onSettingsChange();
  }
</script>

<section class="result">
  <div class="viewport">
    <CanvasView image={shown} class="page" />
    {#if processing}
      <div class="working">Processing…</div>
    {/if}
    <button
      class="compare"
      onpointerdown={() => (comparing = true)}
      onpointerup={() => (comparing = false)}
      onpointerleave={() => (comparing = false)}
      onpointercancel={() => (comparing = false)}
    >
      Hold to compare
    </button>
  </div>

  <div class="sheet">
    <div class="chips">
      {#each PRESETS as preset (preset.id)}
        <button
          class="chip"
          class:active={presetId === preset.id}
          title={preset.hint}
          onclick={() => onPreset(preset.id)}
        >
          {preset.label}
        </button>
      {/each}
    </div>

    <div class="sliders">
      <Slider
        label="Paper whiteness"
        value={settings.composite.paper}
        min={230}
        max={255}
        onchange={(value) => update(() => (settings.composite.paper = value))}
      />
      <Slider
        label="Text boldness"
        value={toBoldness(settings.binarize.k)}
        min={0}
        max={100}
        onchange={(value) => update(() => (settings.binarize.k = fromBoldness(value)))}
      />
      <Slider
        label="Text darkness"
        value={settings.composite.text}
        min={0}
        max={80}
        onchange={(value) => update(() => (settings.composite.text = value))}
      />
      <Slider
        label="Colour despeckle"
        value={settings.color.minArea}
        min={0}
        max={100}
        onchange={(value) => update(() => (settings.color.minArea = value))}
      />
      <Slider
        label="Colour sensitivity"
        value={settings.color.chromaThreshold}
        min={20}
        max={150}
        onchange={(value) => update(() => (settings.color.chromaThreshold = value))}
      />
      <div class="checkbox-row">
        <input
          id="preserve-colour"
          type="checkbox"
          checked={settings.color.enabled}
          onchange={(event) => update(() => (settings.color.enabled = event.currentTarget.checked))}
        />
        <label for="preserve-colour">Preserve colour (logos, stamps, signatures)</label>
      </div>
    </div>

    <button class="advanced-toggle" aria-expanded={advanced} onclick={() => (advanced = !advanced)}>
      {advanced ? 'Hide' : 'Show'} advanced settings
    </button>

    {#if advanced}
      <div class="sliders advanced">
        <Slider
          label="Illumination"
          value={settings.normalize.radius}
          min={0}
          max={120}
          onchange={(value) => update(() => (settings.normalize.radius = value))}
        />
        <Slider
          label="Threshold window"
          value={settings.binarize.window}
          min={9}
          max={99}
          step={2}
          onchange={(value) => update(() => (settings.binarize.window = value))}
        />
        <Slider
          label="Edge feather"
          value={settings.composite.feather}
          min={0}
          max={4}
          onchange={(value) => update(() => (settings.composite.feather = value))}
        />
        <Slider
          label="Target DPI"
          value={settings.output.targetDpi}
          min={150}
          max={600}
          step={50}
          onchange={(value) => update(() => (settings.output.targetDpi = value))}
        />
        <Slider
          label="Max long edge"
          value={settings.output.maxLongEdge}
          min={1000}
          max={4000}
          step={100}
          onchange={(value) => update(() => (settings.output.maxLongEdge = value))}
        />
        <div class="slider-row">
          <label for="method">Binarisation</label>
          <select
            id="method"
            value={settings.binarize.method}
            onchange={(event) =>
              update(
                () => (settings.binarize.method = event.currentTarget.value as BinarizeMethod),
              )}
          >
            {#each METHODS as method (method.value)}
              <option value={method.value}>{method.label}</option>
            {/each}
          </select>
        </div>
        <div class="checkbox-row">
          <input
            id="invert"
            type="checkbox"
            checked={settings.binarize.invert}
            onchange={(event) =>
              update(() => (settings.binarize.invert = event.currentTarget.checked))}
          />
          <label for="invert">Invert (light text on a dark background)</label>
        </div>
      </div>
    {/if}
  </div>

  <div class="screen-actions">
    <button onclick={onRecrop}>Recrop</button>
    <button onclick={onSave}>Save PNG</button>
    <button class="btn-primary" onclick={onUpload}>Upload</button>
  </div>
</section>

<style>
  .result {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    background: #1a1a1a;
  }

  .viewport {
    position: relative;
    flex: 1 1 auto;
    overflow: hidden;
    background: #2a2a2a;
  }

  .viewport :global(canvas.page) {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
  }

  .working {
    position: absolute;
    top: 12px;
    left: 12px;
    background: rgb(0 0 0 / 70%);
    backdrop-filter: blur(8px);
    border-radius: 999px;
    padding: 5px 12px;
    font-size: 12px;
    color: rgb(255 255 255 / 85%);
  }

  .compare {
    position: absolute;
    top: 12px;
    right: 12px;
    background: rgb(0 0 0 / 70%);
    backdrop-filter: blur(8px);
    color: #fff;
    border: 1px solid rgb(255 255 255 / 15%);
    font-size: 12px;
    padding: 6px 12px;
    border-radius: 20px;
  }

  .sheet {
    flex: 0 0 auto;
    background: var(--panel);
    border-top: 1px solid var(--border);
    padding: 12px 14px;
    max-height: 46dvh;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
  }

  .sliders {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 12px;
  }

  .advanced {
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }

  .advanced-toggle {
    width: 100%;
    margin-top: 12px;
    font-size: 13px;
    color: var(--muted);
    background: transparent;
    border: 1px dashed var(--border);
  }

  select {
    flex: 1;
    padding: 8px 10px;
    border-radius: 8px;
    background: var(--panel-2);
    border: 1px solid var(--border);
    color: var(--text);
    font-family: inherit;
    font-size: 13px;
  }
</style>
