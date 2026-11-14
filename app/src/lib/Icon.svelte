<script lang="ts" module>
  // 24x24 line icons (stroke) as single path strings; `fill` marks solid glyphs.
  const ICONS = {
    play: { d: 'M8 5.6v12.8a.6.6 0 0 0 .9.5l10.2-6.4a.6.6 0 0 0 0-1L8.9 5.1a.6.6 0 0 0-.9.5z', fill: true },
    stop: { d: 'M8.5 6.5h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z', fill: true },
    send: { d: 'M20.5 3.5 10 14M20.5 3.5 14.2 20.5l-4.2-6.5-6.5-4.2z' },
    download: { d: 'M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14' },
    trash: { d: 'M4.5 7h15M10 4h4M6.5 7l.8 11.2a2 2 0 0 0 2 1.8h5.4a2 2 0 0 0 2-1.8L17.5 7M10 11v5M14 11v5' },
    folder: { d: 'M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2.2h7.4a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z' },
    terminal: { d: 'M5.5 4.5h13A2.5 2.5 0 0 1 21 7v10a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17V7a2.5 2.5 0 0 1 2.5-2.5zM7 9.5l3 2.5-3 2.5M12.5 15H17' },
    refresh: { d: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4' },
    plug: { d: 'M9 3.5v4M15 3.5v4M6.5 7.5h11v3a5.5 5.5 0 0 1-11 0zM12 16v4.5' },
    chat: { d: 'M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 17h-8l-4.5 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 5 5.5z' },
    cube: { d: 'M12 3 4 7.5v9l8 4.5 8-4.5v-9zM4 7.5 12 12l8-4.5M12 12v9' },
    wave: { d: 'M4 10v4M8 7v10M12 4v16M16 8v8M20 10.5v3' },
    plus: { d: 'M12 5v14M5 12h14' },
    mic: { d: 'M12 3.5a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0v-5a3 3 0 0 0-3-3zM6 11a6 6 0 0 0 12 0M12 17v3.5M9 20.5h6' },
    x: { d: 'M6.5 6.5l11 11M17.5 6.5l-11 11' },
    minus: { d: 'M6 12h12' },
    // Push pin: always on top.
    pin: { d: 'M9 4.5h6M10 4.5v5.2L7.5 13h9L14 9.7V4.5M12 13v6.5' },
    // Window with a left side panel and an arrow into it: dock the avatar into the main window's sidebar.
    dock: { d: 'M5.5 4.5h13A2.5 2.5 0 0 1 21 7v10a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17V7a2.5 2.5 0 0 1 2.5-2.5zM9 4.5v15M17 9.5 14.5 12l2.5 2.5M14.5 12h4' },
    check: { d: 'm5 12.5 4.5 4.5L19 7.5' },
    alert: { d: 'M10.3 4.6 2.9 17.5a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 4.6a2 2 0 0 0-3.4 0zM12 9.5v4.5M12 17.2v.1' },
    info: { d: 'M3.5 12a8.5 8.5 0 1 0 17 0 8.5 8.5 0 1 0-17 0M12 11v5.5M12 7.8v.1' },
    sun: { d: 'M8 12a4 4 0 1 0 8 0 4 4 0 1 0-8 0M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4' },
    moon: { d: 'M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10z' },
    link: { d: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1' },
    'chev-down': { d: 'm6.5 9.5 5.5 5.5 5.5-5.5' },
    globe: { d: 'M3.5 12a8.5 8.5 0 1 0 17 0 8.5 8.5 0 1 0-17 0M3.5 12h17M12 3.5c2.6 2.7 2.6 14.3 0 17M12 3.5c-2.6 2.7-2.6 14.3 0 17' },
    gauge: { d: 'M4.5 17a7.5 7.5 0 1 1 15 0M12 17l3.5-5' },
    eraser: { d: 'M8.5 19.5h11M4.8 14.3l8.5-8.5a2 2 0 0 1 2.8 0l2.1 2.1a2 2 0 0 1 0 2.8l-7.8 7.8H8.5l-3.7-3.7a.4.4 0 0 1 0-.5z' },
    'arrow-down': { d: 'M12 5v14M6.5 13.5 12 19l5.5-5.5' },
    'arrow-up': { d: 'M12 19V5M6.5 10.5 12 5l5.5 5.5' },
    figure: { d: 'M10 4.5a2 2 0 1 0 4 0 2 2 0 1 0-4 0M12 7v7M12 9.5l-5 3M12 9.5l5 3M12 14l-3.5 6.5M12 14l3.5 6.5' },
    'eye-off': { d: 'M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12zM9 12a3 3 0 1 0 6 0 3 3 0 1 0-6 0M4 4l16 16' },
    target: { d: 'M12 3v5M12 16v5M3 12h5M16 12h5M9 12a3 3 0 1 0 6 0 3 3 0 1 0-6 0' },
    file: { d: 'M7 3.5h6.5L18 8v12.5H7zM13.5 3.5V8H18' },
    copy: { d: 'M9 8.5h10.5v12H9zM6 15.5H4.5v-12H15V5' },
    user: { d: 'M8 8a4 4 0 1 0 8 0 4 4 0 1 0-8 0M4.5 20.5a7.5 7.5 0 0 1 15 0' },
    scissors: { d: 'M4 6.5a2.5 2.5 0 1 0 5 0 2.5 2.5 0 1 0-5 0M4 17.5a2.5 2.5 0 1 0 5 0 2.5 2.5 0 1 0-5 0M8.6 8 20 18M8.6 16 20 6' },
    polygon: { d: 'M12 3.5l8.5 6-3.2 10H6.7L3.5 9.5z' },
    brush: { d: 'M19.5 4.5 11 13M11 13l-2-2M8.5 12.5c-2 0-3.5 1.5-3.5 3.5 0 1.5-.8 2.5-1.5 3 3.5.8 7-.5 7-4.5z' },
    wand: { d: 'M4 20 14.5 9.5M16.5 3.5v3M16.5 12.5v3M20.5 9.5h-3M12.5 9.5h-3M19.3 6.7l-1.4 1.4M13.7 6.7l1.4 1.4' },
    undo: { d: 'M9 14 4.5 9.5 9 5M4.5 9.5H14a5.5 5.5 0 0 1 0 11h-3' },
    redo: { d: 'M15 14l4.5-4.5L15 5M19.5 9.5H10a5.5 5.5 0 0 0 0 11h3' },
    'zoom-in': { d: 'M4 10.5a6.5 6.5 0 1 0 13 0 6.5 6.5 0 1 0-13 0M15.2 15.2l4.8 4.8M10.5 8v5M8 10.5h5' },
    'zoom-out': { d: 'M4 10.5a6.5 6.5 0 1 0 13 0 6.5 6.5 0 1 0-13 0M15.2 15.2l4.8 4.8M8 10.5h5' },
    maximize: { d: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5' },
    eye: { d: 'M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12zM9 12a3 3 0 1 0 6 0 3 3 0 1 0-6 0' },
    bulb: { d: 'M9.5 18h5M10.5 21h3M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.4 1.1 2.2h5c0-.8.4-1.6 1.1-2.2A6 6 0 0 0 12 3z' },
    logo: { d: 'M8.5 3h7A5.5 5.5 0 0 1 21 8.5v7a5.5 5.5 0 0 1-5.5 5.5h-7A5.5 5.5 0 0 1 3 15.5v-7A5.5 5.5 0 0 1 8.5 3zM8 10.5v3M12 7.5v9M16 9.5v5' },
  } satisfies Record<string, { d: string; fill?: boolean }>

  export type IconName = keyof typeof ICONS
</script>

<script lang="ts">
  let { name, class: cls = '' }: { name: IconName; class?: string } = $props()
  const icon = $derived<{ d: string; fill?: boolean }>(ICONS[name])
</script>

<svg
  class="i {cls}"
  viewBox="0 0 24 24"
  aria-hidden="true"
  fill={icon.fill ? 'currentColor' : 'none'}
  stroke={icon.fill ? 'none' : 'currentColor'}
  stroke-width="1.75"
  stroke-linecap="round"
  stroke-linejoin="round"><path d={icon.d} /></svg>
