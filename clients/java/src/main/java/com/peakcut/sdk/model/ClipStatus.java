package com.peakcut.sdk.model;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

/** Whether a produced clip passed the QA gate and is playable, or was dropped. */
public enum ClipStatus {

    READY("ready"),
    DROPPED("dropped");

    private final String wire;

    ClipStatus(String wire) {
        this.wire = wire;
    }

    @JsonValue
    public String wireValue() {
        return wire;
    }

    @JsonCreator
    public static ClipStatus fromWire(String value) {
        if (value != null) {
            for (ClipStatus status : values()) {
                if (status.wire.equalsIgnoreCase(value.trim())) {
                    return status;
                }
            }
        }
        throw new IllegalArgumentException("Unknown clip status: " + value);
    }
}
