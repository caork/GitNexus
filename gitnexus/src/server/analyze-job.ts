/**
 * Analyze Job Manager
 *
 * Tracks server-side analysis jobs with:
 * - In-memory Map storage
 * - Single-slot concurrency (one active job at a time)
 * - Same-repo deduplication (returns existing job)
 * - Progress event emission for SSE relay
 * - 1-hour TTL cleanup for completed/failed jobs
 */

import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';

export interface AnalyzeJobProgress {
  phase: string;
  percent: number;
  message: string;
}

export interface AnalyzeJob {
  id: string;
  status: 'queued' | 'cloning' | 'analyzing' | 'loading' | 'complete' | 'failed';
  repoUrl?: string;
  repoPath?: string;
  repoName?: string;
  progress: AnalyzeJobProgress;
  error?: string;
  startedAt: number;
  completedAt?: number;
}

const JOB_TTL_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export class JobManager {
  private jobs = new Map<string, AnalyzeJob>();
  private emitter = new EventEmitter();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  /** Create a new job, or return existing active job for the same repo. */
  createJob(params: { repoUrl?: string; repoPath?: string }): AnalyzeJob {
    // Dedup: return existing active job for the same repo (by URL or path)
    for (const job of this.jobs.values()) {
      if (!this.isTerminal(job.status)) {
        const isSameRepo =
          (params.repoUrl && job.repoUrl === params.repoUrl) ||
          (params.repoPath && job.repoPath === params.repoPath);
        if (isSameRepo) {
          return job;
        }
      }
    }

    // Single-slot: reject if another job is active (different repo)
    for (const job of this.jobs.values()) {
      if (!this.isTerminal(job.status)) {
        throw new Error(`Analysis already in progress (job ${job.id})`);
      }
    }

    const job: AnalyzeJob = {
      id: randomUUID(),
      status: 'queued',
      repoUrl: params.repoUrl,
      repoPath: params.repoPath,
      progress: { phase: 'queued', percent: 0, message: 'Waiting to start...' },
      startedAt: Date.now(),
    };

    this.jobs.set(job.id, job);
    return job;
  }

  getJob(id: string): AnalyzeJob | undefined {
    return this.jobs.get(id);
  }

  updateJob(id: string, update: Partial<Pick<AnalyzeJob, 'status' | 'progress' | 'error' | 'repoPath' | 'repoName' | 'completedAt'>>) {
    const job = this.jobs.get(id);
    if (!job) return;

    Object.assign(job, update);

    if (this.isTerminal(job.status)) {
      job.completedAt = job.completedAt ?? Date.now();
    }

    // Emit exactly one event per updateJob call to prevent SSE double-write
    if (update.status === 'complete' || update.status === 'failed') {
      // Terminal event takes precedence — don't also emit the progress event
      this.emitter.emit(`progress:${id}`, {
        phase: update.status,
        percent: update.status === 'complete' ? 100 : job.progress.percent,
        message: update.status === 'complete' ? 'Complete' : (update.error || 'Failed'),
      });
    } else if (update.progress) {
      this.emitter.emit(`progress:${id}`, update.progress);
    }
  }

  /** Subscribe to progress events for a job. Returns unsubscribe function. */
  onProgress(jobId: string, listener: (progress: AnalyzeJobProgress) => void): () => void {
    const event = `progress:${jobId}`;
    this.emitter.on(event, listener);
    return () => this.emitter.off(event, listener);
  }

  dispose() {
    clearInterval(this.cleanupTimer);
    this.emitter.removeAllListeners();
  }

  private isTerminal(status: AnalyzeJob['status']): boolean {
    return status === 'complete' || status === 'failed';
  }

  private cleanup() {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (this.isTerminal(job.status) && job.completedAt && now - job.completedAt > JOB_TTL_MS) {
        this.jobs.delete(id);
      }
    }
  }
}
