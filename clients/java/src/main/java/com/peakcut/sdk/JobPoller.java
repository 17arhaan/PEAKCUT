package com.peakcut.sdk;

import com.peakcut.sdk.model.JobStatus;

import java.time.Duration;
import java.time.Instant;
import java.util.Objects;
import java.util.function.Consumer;

/**
 * Polls a job's status until it reaches a terminal state, invoking an optional
 * callback on every tick so you can render live progress. Configure the interval,
 * an overall timeout, and the progress listener fluently:
 *
 * <pre>{@code
 * JobStatus result = peakcut.poller(jobId)
 *     .interval(Duration.ofSeconds(2))
 *     .timeout(Duration.ofMinutes(30))
 *     .onTick(s -> System.out.printf("  %3d%%  %s%n",
 *         s.progressPercent(), s.stage().orElse("…")))
 *     .await();
 * }</pre>
 */
public final class JobPoller {

    private final PeakcutClient client;
    private final String jobId;

    private Duration interval = Duration.ofSeconds(2);
    private Duration timeout = Duration.ofMinutes(45);
    private Consumer<JobStatus> onTick = status -> { };

    JobPoller(PeakcutClient client, String jobId) {
        this.client = client;
        this.jobId = jobId;
    }

    /** How often to poll (default 2s). */
    public JobPoller interval(Duration interval) {
        if (interval.isNegative() || interval.isZero()) {
            throw new IllegalArgumentException("interval must be positive");
        }
        this.interval = interval;
        return this;
    }

    /** Give up after this long (default 45m). */
    public JobPoller timeout(Duration timeout) {
        this.timeout = Objects.requireNonNull(timeout);
        return this;
    }

    /** Called with every status snapshot, including the terminal one. */
    public JobPoller onTick(Consumer<JobStatus> onTick) {
        this.onTick = Objects.requireNonNull(onTick);
        return this;
    }

    /**
     * Block until the job is {@code DONE} or {@code FAILED}, then return the final
     * status.
     *
     * @throws PeakcutException if the timeout elapses first
     * @throws ApiException on an API error while polling
     */
    public JobStatus await() {
        Instant deadline = Instant.now().plus(timeout);
        while (true) {
            JobStatus status = client.getStatus(jobId);
            onTick.accept(status);
            if (status.isTerminal()) {
                return status;
            }
            if (Instant.now().isAfter(deadline)) {
                throw new PeakcutException(
                        "Job " + jobId + " did not finish within " + timeout);
            }
            sleep(interval);
        }
    }

    /**
     * Like {@link #await()} but treats a {@code FAILED} job as an error, so callers
     * that only care about the happy path don't have to check the state.
     *
     * @throws PeakcutException if the job fails
     */
    public JobStatus awaitDone() {
        JobStatus status = await();
        if (status.state() != null && status.state().name().equals("FAILED")) {
            throw new PeakcutException("Job " + jobId + " failed: "
                    + status.error().orElse("unknown error"));
        }
        return status;
    }

    private static void sleep(Duration duration) {
        try {
            Thread.sleep(duration.toMillis());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new PeakcutException("Polling interrupted", e);
        }
    }
}
