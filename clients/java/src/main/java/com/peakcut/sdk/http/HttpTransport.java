package com.peakcut.sdk.http;

import com.peakcut.sdk.ApiException;
import com.peakcut.sdk.PeakcutClientConfig;
import com.peakcut.sdk.PeakcutException;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Path;
import java.time.Duration;

/**
 * The SDK's HTTP layer, built on the JDK's {@link HttpClient}. Handles auth headers,
 * JSON content types, and transparent retries with exponential backoff for transient
 * failures (429, 5xx, and I/O timeouts). Non-2xx responses become {@link ApiException};
 * transport failures become {@link PeakcutException}.
 */
public final class HttpTransport {

    private final PeakcutClientConfig config;
    private final HttpClient httpClient;

    public HttpTransport(PeakcutClientConfig config) {
        this.config = config;
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(config.connectTimeout())
                .followRedirects(HttpClient.Redirect.NORMAL)
                .build();
    }

    /** GET {@code path}, returning the response body as a string. */
    public String get(String path) {
        return send(baseRequest(path).GET().build());
    }

    /** POST {@code path} with a JSON body, returning the response body as a string. */
    public String postJson(String path, String jsonBody) {
        HttpRequest request = baseRequest(path)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(jsonBody))
                .build();
        return send(request);
    }

    /** POST a raw file (e.g. a video upload), returning the response body. */
    public String postFile(String path, Path file, String contentType) {
        try {
            HttpRequest request = baseRequest(path)
                    .header("Content-Type", contentType)
                    .POST(HttpRequest.BodyPublishers.ofFile(file))
                    .build();
            return send(request);
        } catch (IOException e) {
            throw new PeakcutException("Failed to read file for upload: " + file, e);
        }
    }

    /** Stream a GET response body straight to {@code target} (used for downloads). */
    public void download(String absoluteUrl, Path target) {
        HttpRequest request = HttpRequest.newBuilder(URI.create(absoluteUrl))
                .timeout(Duration.ofMinutes(5))
                .header("User-Agent", config.userAgent())
                .GET()
                .build();
        try {
            HttpResponse<Path> response =
                    httpClient.send(request, HttpResponse.BodyHandlers.ofFile(target));
            if (response.statusCode() / 100 != 2) {
                throw new ApiException(response.statusCode(), "download failed");
            }
        } catch (IOException e) {
            throw new PeakcutException("Download failed: " + absoluteUrl, e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new PeakcutException("Download interrupted", e);
        }
    }

    private HttpRequest.Builder baseRequest(String path) {
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(config.baseUrl() + path))
                .timeout(config.requestTimeout())
                .header("Accept", "application/json")
                .header("User-Agent", config.userAgent());
        if (config.authToken() != null && !config.authToken().isBlank()) {
            builder.header("Authorization", "Bearer " + config.authToken());
        }
        return builder;
    }

    private String send(HttpRequest request) {
        PeakcutException last = null;
        for (int attempt = 0; attempt <= config.maxRetries(); attempt++) {
            try {
                HttpResponse<String> response =
                        httpClient.send(request, HttpResponse.BodyHandlers.ofString());
                int status = response.statusCode();
                if (status / 100 == 2) {
                    return response.body();
                }
                ApiException api = new ApiException(status, response.body());
                if (!api.isRetryable() || attempt == config.maxRetries()) {
                    throw api;
                }
                last = api;
            } catch (IOException e) {
                last = new PeakcutException("Transport error calling " + request.uri(), e);
                if (attempt == config.maxRetries()) {
                    throw last;
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new PeakcutException("Request interrupted", e);
            }
            backoff(attempt);
        }
        // Unreachable in practice, but keeps the compiler happy.
        throw last != null ? last : new PeakcutException("Request failed with no response");
    }

    private void backoff(int attempt) {
        long millis = (long) (config.retryBaseDelay().toMillis() * Math.pow(2, attempt));
        try {
            Thread.sleep(Math.min(millis, 8_000L));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new PeakcutException("Backoff interrupted", e);
        }
    }
}
