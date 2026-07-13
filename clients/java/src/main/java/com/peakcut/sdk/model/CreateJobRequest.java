package com.peakcut.sdk.model;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.Objects;

/**
 * The payload for creating a job. Build one with {@link #fromUrl(String)} for a link
 * source, or {@link #fromUpload(String)} for a previously-uploaded file referenced by
 * its storage key.
 */
public final class CreateJobRequest {

    private final String source;
    private final SourceType sourceType;

    private CreateJobRequest(String source, SourceType sourceType) {
        this.source = Objects.requireNonNull(source, "source");
        this.sourceType = Objects.requireNonNull(sourceType, "sourceType");
    }

    /**
     * A job whose source is a downloadable URL (e.g. a YouTube watch link).
     *
     * @param url the http(s) URL to pull
     */
    public static CreateJobRequest fromUrl(String url) {
        if (url == null || url.isBlank()) {
            throw new IllegalArgumentException("url must not be blank");
        }
        return new CreateJobRequest(url.trim(), SourceType.URL);
    }

    /**
     * A job whose source is a file already streamed to the upload endpoint.
     *
     * @param storageKey the key returned by the upload step
     */
    public static CreateJobRequest fromUpload(String storageKey) {
        if (storageKey == null || storageKey.isBlank()) {
            throw new IllegalArgumentException("storageKey must not be blank");
        }
        return new CreateJobRequest(storageKey.trim(), SourceType.UPLOAD);
    }

    @JsonProperty("source")
    public String source() {
        return source;
    }

    @JsonProperty("sourceType")
    public SourceType sourceType() {
        return sourceType;
    }

    @Override
    public String toString() {
        return "CreateJobRequest{sourceType=" + sourceType + ", source=" + source + '}';
    }
}
