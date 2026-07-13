# Peakcut Java SDK

A Java 17 client library and CLI for the [Peakcut](https://github.com/17arhaan/PEAKCUT) API:
submit a long video, watch the agent pipeline work in real time, and pull back the
vertical clips — each with the evidence behind why it was picked.

No third-party HTTP dependency (built on the JDK `HttpClient`); Jackson for JSON.

## Build

```bash
cd clients/java
mvn package          # runs tests + builds a runnable fat-jar at target/peakcut.jar
```

## Library usage

```java
import com.peakcut.sdk.*;
import com.peakcut.sdk.model.*;
import java.nio.file.Path;

PeakcutClient peakcut = PeakcutClient.create(
        "https://peakcut.app", System.getenv("PEAKCUT_TOKEN"));

// Submit a link (or peakcut.submitUpload(Path.of("talk.mp4")) for a file)
Job job = peakcut.submitUrl("https://youtu.be/ZIsb3MYB79k");

// Block until done, printing live progress
JobStatus done = peakcut.poller(job.id())
        .interval(java.time.Duration.ofSeconds(2))
        .onTick(s -> System.out.printf("  %3d%%  %s%n",
                s.progressPercent(), s.stage().orElse("…")))
        .awaitDone();

// Pull the clips + their receipts
for (Clip clip : done.readyClips()) {
    System.out.println(clip.hook().orElse("clip " + clip.index())
            + "  (" + clip.score().orElse(0) + "/100)");
    clip.evidence().ifPresent(ev ->
            System.out.println("    top signal: " + ev.topComponent().name()));
    peakcut.downloadClip(clip, Path.of("clips", "clip_" + clip.index() + ".mp4"));
}
```

## CLI

```bash
export PEAKCUT_BASE_URL=https://peakcut.app
export PEAKCUT_TOKEN=…            # your session/bearer token

java -jar target/peakcut.jar submit --url https://youtu.be/… --watch --out ./clips
java -jar target/peakcut.jar submit --file talk.mp4 --watch
java -jar target/peakcut.jar status  <jobId>
java -jar target/peakcut.jar watch   <jobId> --interval 3
java -jar target/peakcut.jar download <jobId> --out ./clips
```

## Layout

```
com.peakcut.sdk         PeakcutClient, JobPoller, config, exceptions
com.peakcut.sdk.http    HttpTransport (retry/backoff), JsonMapper
com.peakcut.sdk.model   immutable value types (Job, JobStatus, Clip, ClipEvidence, …)
com.peakcut.cli         PeakcutCli — the command-line front end
```

## Error handling

Everything throws `PeakcutException`; HTTP errors are the `ApiException` subclass with
`status()`, `body()`, and helpers such as `isOutOfCredits()` (402), `isNotFound()` (404),
`isAuthError()` (401/403), and `isRetryable()` (429/5xx). Retryable failures are retried
automatically with exponential backoff (configurable via `PeakcutClientConfig`).
