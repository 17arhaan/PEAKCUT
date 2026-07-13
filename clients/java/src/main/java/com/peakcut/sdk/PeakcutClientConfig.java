package com.peakcut.sdk;

import java.time.Duration;
import java.util.Objects;

/**
 * Immutable configuration for a {@link PeakcutClient}. Build one with the fluent
 * {@link Builder} — only the base URL and an auth token are required.
 *
 * <pre>{@code
 * PeakcutClientConfig cfg = PeakcutClientConfig.builder()
 *     .baseUrl("https://peakcut.app")
 *     .authToken(System.getenv("PEAKCUT_TOKEN"))
 *     .requestTimeout(Duration.ofSeconds(30))
 *     .maxRetries(3)
 *     .build();
 * }</pre>
 */
public final class PeakcutClientConfig {

    private final String baseUrl;
    private final String authToken;
    private final Duration connectTimeout;
    private final Duration requestTimeout;
    private final int maxRetries;
    private final Duration retryBaseDelay;
    private final String userAgent;

    private PeakcutClientConfig(Builder b) {
        this.baseUrl = stripTrailingSlash(Objects.requireNonNull(b.baseUrl, "baseUrl"));
        this.authToken = b.authToken;
        this.connectTimeout = b.connectTimeout;
        this.requestTimeout = b.requestTimeout;
        this.maxRetries = b.maxRetries;
        this.retryBaseDelay = b.retryBaseDelay;
        this.userAgent = b.userAgent;
    }

    public String baseUrl() {
        return baseUrl;
    }

    public String authToken() {
        return authToken;
    }

    public Duration connectTimeout() {
        return connectTimeout;
    }

    public Duration requestTimeout() {
        return requestTimeout;
    }

    public int maxRetries() {
        return maxRetries;
    }

    public Duration retryBaseDelay() {
        return retryBaseDelay;
    }

    public String userAgent() {
        return userAgent;
    }

    public static Builder builder() {
        return new Builder();
    }

    private static String stripTrailingSlash(String url) {
        return url.endsWith("/") ? url.substring(0, url.length() - 1) : url;
    }

    /** Fluent builder for {@link PeakcutClientConfig}. */
    public static final class Builder {
        private String baseUrl = "http://localhost:3000";
        private String authToken;
        private Duration connectTimeout = Duration.ofSeconds(10);
        private Duration requestTimeout = Duration.ofSeconds(30);
        private int maxRetries = 3;
        private Duration retryBaseDelay = Duration.ofMillis(500);
        private String userAgent = "peakcut-java-sdk/0.1.0";

        /** The API origin, e.g. {@code https://peakcut.app} (no trailing path). */
        public Builder baseUrl(String baseUrl) {
            this.baseUrl = baseUrl;
            return this;
        }

        /** A session/bearer token sent as {@code Authorization: Bearer <token>}. */
        public Builder authToken(String authToken) {
            this.authToken = authToken;
            return this;
        }

        public Builder connectTimeout(Duration connectTimeout) {
            this.connectTimeout = Objects.requireNonNull(connectTimeout);
            return this;
        }

        public Builder requestTimeout(Duration requestTimeout) {
            this.requestTimeout = Objects.requireNonNull(requestTimeout);
            return this;
        }

        /** How many times to retry retryable failures (429/5xx/timeouts). */
        public Builder maxRetries(int maxRetries) {
            if (maxRetries < 0) {
                throw new IllegalArgumentException("maxRetries must be >= 0");
            }
            this.maxRetries = maxRetries;
            return this;
        }

        /** Base delay for exponential backoff between retries. */
        public Builder retryBaseDelay(Duration retryBaseDelay) {
            this.retryBaseDelay = Objects.requireNonNull(retryBaseDelay);
            return this;
        }

        public Builder userAgent(String userAgent) {
            this.userAgent = Objects.requireNonNull(userAgent);
            return this;
        }

        public PeakcutClientConfig build() {
            return new PeakcutClientConfig(this);
        }
    }
}
