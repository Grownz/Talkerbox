<script lang="ts">
  // Button for `.fit` toolbars (see fit.ts): icon + full label, optional short label.
  // `p` = priority; lower collapses first. Always pass a `title`: it is the tooltip when collapsed.
  import type { HTMLButtonAttributes } from 'svelte/elements'
  import Icon, { type IconName } from './Icon.svelte'

  let {
    icon,
    label,
    short,
    p = 0,
    class: cls = '',
    ...rest
  }: Omit<HTMLButtonAttributes, 'aria-label'> & { icon: IconName; label: string; short?: string; p?: number } = $props()
</script>

<button type="button" class={cls} data-fit data-p={p} {...rest}
  ><Icon name={icon} /><span class="l"><span class="full">{label}</span>{#if short}<span class="short">{short}</span>{/if}</span></button
>
