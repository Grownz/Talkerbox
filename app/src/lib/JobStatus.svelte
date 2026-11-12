<script lang="ts">
  import type { Job } from './job.svelte'

  let { job, text }: { job: Job; text: string } = $props()
  const pct = $derived(
    job.progress?.total && job.progress.completed != null ? Math.min(100, (job.progress.completed / job.progress.total) * 100) : null,
  )
</script>

{#if job.busy}
  <div class="prog-row">
    <div
      class="progress"
      class:indet={pct === null}
      role="progressbar"
      aria-label={text || 'Starting…'}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct ?? undefined}
    >
      <i style:--p={`${pct ?? 0}%`}></i>
    </div>
    <span>{text || 'Starting…'}</span>
  </div>
{:else if job.error}
  <p class="err-text" role="alert">{job.error}</p>
{:else if job.result}
  <p class="ok-text">{job.result}</p>
{/if}
