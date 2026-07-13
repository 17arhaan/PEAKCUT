package com.peakcut.sdk;

import com.peakcut.sdk.http.HttpTransport;
import com.peakcut.sdk.http.JsonMapper;
import com.peakcut.sdk.model.Clip;
import com.peakcut.sdk.model.CreateJobRequest;
import com.peakcut.sdk.model.Job;
import com.peakcut.sdk.model.JobStatus;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Objects;

/**
 * The main entry point to the Peakcut API. Create one with a
 * {@link PeakcutClientConfig} (base URL + auth token) and reuse it — it is
 * thread-safe and holds a pooled HTTP client.
 *
 * <pre>{@code
 * PeakcutClient peakcut = PeakcutClient.create(cfg);
 *
 * Job job = peakcut.createJob(CreateJobRequest.fromUrl("https://youtu.be/…"));
 * JobStatus done = peakcut.poller(job.id()).await();   // blocks until DONE/FAILED
 *
 * for (Clip clip : done.readyClips()) {
 *     System.out.println(clip.hook().orElse("clip " + clip.index())
 *         + "  (" + clip.score().orElse(0) + "/100)");
 * }
 * }</pre>
 */
public final class PeakcutClient {

    private final HttpTransport transport;
    private final JsonMapper json;

    private PeakcutClient(PeakcutClientConfig config) {
        this.transport = new HttpTransport(Objects.requireNonNull(config, "config"));
        this.json = new JsonMapper();
    }

    /** Create a client from a full config. */
    public static PeakcutClient create(PeakcutClientConfig config) {
        return new PeakcutClient(config);
    }

    /** Shorthand: a client pointed at {@code baseUrl} with the given auth token. */
    public static PeakcutClient create(String baseUrl, String authToken) {
        return create(PeakcutClientConfig.builder().baseUrl(baseUrl).authToken(authToken).build());
    }

    /**
     * Submit a new job. The pipeline debits your minute balance and starts work;
     * the returned {@link Job} carries the id to poll.
     *
     * @throws ApiException {@code 402} if you're out of minutes, {@code 401} if unauthenticated
     */
    public Job createJob(CreateJobRequest request) {
        Objects.requireNonNull(request, "request");
        String body = transport.postJson("/api/jobs", json.write(request));
        return json.read(body, Job.class);
    }

    /** Convenience: submit a URL job in one call. */
    public Job submitUrl(String url) {
        return createJob(CreateJobRequest.fromUrl(url));
    }

    /**
     * Upload a local video file, then submit it as a job. The file is streamed to
     * the upload endpoint and referenced by a generated storage key.
     *
     * @param file the local video to process
     */
    public Job submitUpload(Path file) {
        if (!Files.isRegularFile(file)) {
            throw new IllegalArgumentException("Not a readable file: " + file);
        }
        String key = "u/sdk/" + java.util.UUID.randomUUID() + "/" + file.getFileName();
        transport.postFile("/api/upload?key=" + encode(key), file, "video/mp4");
        return createJob(CreateJobRequest.fromUpload(key));
    }

    /**
     * Fetch the current status of a job.
     *
     * @throws ApiException {@code 404} if the job doesn't exist or isn't yours
     */
    public JobStatus getStatus(String jobId) {
        requireId(jobId);
        String body = transport.get("/api/jobs/" + encode(jobId) + "/status");
        return json.read(body, JobStatus.class);
    }

    /** A {@link JobPoller} bound to this client and {@code jobId}. */
    public JobPoller poller(String jobId) {
        requireId(jobId);
        return new JobPoller(this, jobId);
    }

    /**
     * Download a ready clip's mp4 to {@code target}.
     *
     * @throws PeakcutException if the clip is not ready (has no media URL)
     */
    public void downloadClip(Clip clip, Path target) {
        String url = clip.mp4Url().orElseThrow(
                () -> new PeakcutException("Clip " + clip.index() + " has no media (status="
                        + clip.status() + ")"));
        transport.download(url, target);
    }

    private static void requireId(String jobId) {
        if (jobId == null || jobId.isBlank()) {
            throw new IllegalArgumentException("jobId must not be blank");
        }
    }

    private static String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }
}
