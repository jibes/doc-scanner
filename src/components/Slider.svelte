<script lang="ts">
  interface Props {
    label: string;
    value: number;
    min: number;
    max: number;
    step?: number;
    format?: (value: number) => string;
    onchange: (value: number) => void;
  }

  let { label, value, min, max, step = 1, format, onchange }: Props = $props();

  const id = $props.id();
</script>

<div class="slider-row">
  <label for={id}>{label}</label>
  <input
    {id}
    type="range"
    {min}
    {max}
    {step}
    {value}
    oninput={(event) => onchange(Number(event.currentTarget.value))}
  />
  <div class="value">{format ? format(value) : value}</div>
</div>
