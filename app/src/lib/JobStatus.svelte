<script lang="ts">
  import type { Job } from './job.svelte'

  let { job, text }: { job: Job; text: string } = $props()
</script>

{#if job.busy}
  <div class="progress">
    {#if job.progress?.total && job.progress.completed != null}
      <progress value={job.progress.completed} max={job.progress.total}></progress>
    {:else}
      <progress></progress>
    {/if}
    <span>{text || 'Starting…'}</span>
  </div>
{:else if job.error}
  <p class="error" role="alert">{job.error}</p>
{:else if job.result}
  <p class="ok">{job.result}</p>
{/if}
