package com.peakcut.cli;

import com.peakcut.sdk.ApiException;
import com.peakcut.sdk.PeakcutClient;
import com.peakcut.sdk.PeakcutClientConfig;
import com.peakcut.sdk.PeakcutException;
import com.peakcut.sdk.model.Clip;
import com.peakcut.sdk.model.Job;
import com.peakcut.sdk.model.JobStatus;

import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * A small command-line front end over {@link PeakcutClient}. Build the fat jar with
 * {@code mvn package} and run:
 *
 * <pre>
 *   java -jar target/peakcut.jar submit --url https://youtu.be/… --watch
 *   java -jar target/peakcut.jar submit --file talk.mp4 --out ./clips
 *   java -jar target/peakcut.jar status &lt;jobId&gt;
 *   java -jar target/peakcut.jar watch  &lt;jobId&gt;
 *   java -jar target/peakcut.jar download &lt;jobId&gt; --out ./clips
 * </pre>
 *
 * <p>Base URL and token come from {@code --base-url}/{@code --token} or the
 * {@code PEAKCUT_BASE_URL}/{@code PEAKCUT_TOKEN} environment variables.
 */
public final class PeakcutCli {

    public static void main(String[] args) {
        try {
            System.exit(new PeakcutCli().run(args));
        } catch (ApiException e) {
            System.err.println("API error (HTTP " + e.status() + "): " + e.body());
            System.exit(2);
        } catch (PeakcutException e) {
            System.err.println("Error: " + e.getMessage());
            System.exit(1);
        }
    }

    int run(String[] args) {
        if (args.length == 0 || isHelp(args[0])) {
            printUsage();
            return args.length == 0 ? 1 : 0;
        }
        String command = args[0];
        Args parsed = Args.parse(args, 1);
        PeakcutClient client = buildClient(parsed);

        return switch (command) {
            case "submit" -> submit(client, parsed);
            case "status" -> status(client, parsed);
            case "watch" -> watch(client, parsed);
            case "download" -> download(client, parsed);
            default -> {
                System.err.println("Unknown command: " + command);
                printUsage();
                yield 1;
            }
        };
    }

    private int submit(PeakcutClient client, Args a) {
        Job job;
        if (a.has("url")) {
            job = client.submitUrl(a.require("url"));
        } else if (a.has("file")) {
            job = client.submitUpload(Path.of(a.require("file")));
        } else {
            System.err.println("submit needs --url <link> or --file <path>");
            return 1;
        }
        System.out.println("Created job " + job.id() + " (" + job.state() + ")");
        if (a.flag("watch")) {
            JobStatus done = pollWithProgress(client, job.id(), a);
            printClips(done);
            if (a.has("out")) {
                saveClips(client, done, Path.of(a.require("out")));
            }
        }
        return 0;
    }

    private int status(PeakcutClient client, Args a) {
        JobStatus s = client.getStatus(a.positionalOrThrow("jobId"));
        System.out.println(s);
        s.error().ifPresent(err -> System.out.println("  error: " + err));
        printClips(s);
        return 0;
    }

    private int watch(PeakcutClient client, Args a) {
        JobStatus done = pollWithProgress(client, a.positionalOrThrow("jobId"), a);
        printClips(done);
        return 0;
    }

    private int download(PeakcutClient client, Args a) {
        JobStatus s = client.getStatus(a.positionalOrThrow("jobId"));
        saveClips(client, s, Path.of(a.getOrDefault("out", "./clips")));
        return 0;
    }

    // --- helpers ----------------------------------------------------------

    private JobStatus pollWithProgress(PeakcutClient client, String jobId, Args a) {
        Duration interval = Duration.ofSeconds(a.getInt("interval", 2));
        return client.poller(jobId)
                .interval(interval)
                .onTick(s -> System.out.printf("  %3d%%  %-10s %s%n",
                        s.progressPercent(),
                        s.state(),
                        s.stage().orElse("")))
                .await();
    }

    private void printClips(JobStatus s) {
        List<Clip> clips = s.clips();
        if (clips.isEmpty()) {
            System.out.println("  (no clips yet)");
            return;
        }
        for (Clip c : clips) {
            if (c.isReady()) {
                System.out.printf("  #%d  %-3s  %s%n",
                        c.index(),
                        c.score().map(String::valueOf).orElse("—"),
                        c.hook().orElse("(untitled)"));
            } else {
                System.out.printf("  #%d  dropped: %s%n",
                        c.index(), c.droppedReason().orElse("unknown"));
            }
        }
    }

    private void saveClips(PeakcutClient client, JobStatus s, Path outDir) {
        try {
            java.nio.file.Files.createDirectories(outDir);
        } catch (Exception e) {
            throw new PeakcutException("Could not create output dir " + outDir, e);
        }
        int saved = 0;
        for (Clip c : s.readyClips()) {
            Path target = outDir.resolve("clip_" + String.format("%03d", c.index()) + ".mp4");
            client.downloadClip(c, target);
            System.out.println("  saved " + target);
            saved++;
        }
        System.out.println(saved + " clip(s) downloaded to " + outDir);
    }

    private PeakcutClient buildClient(Args a) {
        String baseUrl = a.getOrEnv("base-url", "PEAKCUT_BASE_URL", "http://localhost:3000");
        String token = a.getOrEnv("token", "PEAKCUT_TOKEN", null);
        return PeakcutClient.create(PeakcutClientConfig.builder()
                .baseUrl(baseUrl)
                .authToken(token)
                .build());
    }

    private static boolean isHelp(String arg) {
        return arg.equals("-h") || arg.equals("--help") || arg.equals("help");
    }

    private void printUsage() {
        System.out.println("""
            Peakcut CLI — turn long videos into vertical clips.

            Usage:
              peakcut submit   (--url <link> | --file <path>) [--watch] [--out <dir>]
              peakcut status   <jobId>
              peakcut watch    <jobId> [--interval <sec>]
              peakcut download <jobId> [--out <dir>]

            Auth:
              --base-url <url>   or  PEAKCUT_BASE_URL   (default http://localhost:3000)
              --token <token>    or  PEAKCUT_TOKEN
            """);
    }

    /** Minimal {@code --key value} / {@code --flag} / positional argument parser. */
    static final class Args {
        /** Options that are boolean flags and never consume the next token —
         *  without this, {@code --watch job_123} would eat the positional
         *  jobId as the flag's "value". */
        private static final Set<String> BOOLEAN_FLAGS = Set.of("watch");

        private final Map<String, String> options = new HashMap<>();
        private final List<String> positionals = new ArrayList<>();

        static Args parse(String[] argv, int from) {
            Args a = new Args();
            for (int i = from; i < argv.length; i++) {
                String tok = argv[i];
                if (tok.startsWith("--")) {
                    String key = tok.substring(2);
                    if (!BOOLEAN_FLAGS.contains(key)
                            && i + 1 < argv.length
                            && !argv[i + 1].startsWith("--")) {
                        a.options.put(key, argv[++i]);
                    } else {
                        a.options.put(key, "true"); // bare flag
                    }
                } else {
                    a.positionals.add(tok);
                }
            }
            return a;
        }

        boolean has(String key) {
            return options.containsKey(key);
        }

        boolean flag(String key) {
            return "true".equals(options.get(key));
        }

        String require(String key) {
            String v = options.get(key);
            if (v == null) {
                throw new PeakcutException("Missing required option --" + key);
            }
            return v;
        }

        String getOrDefault(String key, String fallback) {
            return options.getOrDefault(key, fallback);
        }

        int getInt(String key, int fallback) {
            String v = options.get(key);
            return v == null ? fallback : Integer.parseInt(v);
        }

        String getOrEnv(String key, String envVar, String fallback) {
            if (options.containsKey(key)) {
                return options.get(key);
            }
            String env = System.getenv(envVar);
            return env != null ? env : fallback;
        }

        String positionalOrThrow(String name) {
            if (positionals.isEmpty()) {
                throw new PeakcutException("Missing required argument <" + name + ">");
            }
            return positionals.get(0);
        }
    }
}
