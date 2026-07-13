package com.peakcut.sdk.model;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

/**
 * Where a job's source video comes from.
 *
 * <ul>
 *   <li>{@link #URL} — a link (e.g. a YouTube watch URL) the pipeline downloads.</li>
 *   <li>{@link #UPLOAD} — a file the client streamed to the upload endpoint first,
 *       referenced by its storage key.</li>
 * </ul>
 */
public enum SourceType {

    URL("url"),
    UPLOAD("upload");

    private final String wire;

    SourceType(String wire) {
        this.wire = wire;
    }

    @JsonValue
    public String wireValue() {
        return wire;
    }

    @JsonCreator
    public static SourceType fromWire(String value) {
        if (value != null) {
            for (SourceType type : values()) {
                if (type.wire.equalsIgnoreCase(value.trim())) {
                    return type;
                }
            }
        }
        throw new IllegalArgumentException("Unknown source type: " + value);
    }
}
