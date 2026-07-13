/**
 * Java client library for the <a href="https://github.com/17arhaan/PEAKCUT">Peakcut</a>
 * API — submit a long video, watch the agent pipeline work, and pull back the
 * vertical clips with the evidence behind each one.
 *
 * <h2>Quick start</h2>
 * <pre>{@code
 * PeakcutClient peakcut = PeakcutClient.create("https://peakcut.app", System.getenv("PEAKCUT_TOKEN"));
 *
 * Job job = peakcut.submitUrl("https://youtu.be/…");
 * JobStatus done = peakcut.poller(job.id())
 *     .onTick(s -> System.out.printf("%3d%% %s%n", s.progressPercent(), s.stage().orElse("")))
 *     .awaitDone();
 *
 * for (Clip clip : done.readyClips()) {
 *     peakcut.downloadClip(clip, Path.of("clips", "clip_" + clip.index() + ".mp4"));
 * }
 * }</pre>
 *
 * <h2>Design</h2>
 * <ul>
 *   <li>{@link com.peakcut.sdk.PeakcutClient} is the entry point; it is thread-safe
 *       and should be reused.</li>
 *   <li>Transport ({@link com.peakcut.sdk.http.HttpTransport}) uses the JDK
 *       {@code HttpClient} with transparent backoff-retry on 429/5xx and I/O errors —
 *       no third-party HTTP dependency.</li>
 *   <li>Every failure surfaces as {@link com.peakcut.sdk.PeakcutException}; HTTP error
 *       responses as {@link com.peakcut.sdk.ApiException} with helpers like
 *       {@code isOutOfCredits()} and {@code isNotFound()}.</li>
 *   <li>Models under {@link com.peakcut.sdk.model} are immutable value types with the
 *       same "clips ship with their receipts" shape the product exposes.</li>
 * </ul>
 */
package com.peakcut.sdk;
