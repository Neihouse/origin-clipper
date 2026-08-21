import { describe, expect, it } from "vitest";
import {
  formatZonedDateTime,
  scheduleInputBounds,
  toZonedDateTimeInputValue,
  zonedLocalDateTimeToIso,
} from "./local-time";

describe("Pacific scheduling time", () => {
  it("converts Pacific daylight time to an explicit UTC instant", () => {
    expect(zonedLocalDateTimeToIso("2026-08-20T18:00")).toEqual({
      iso: "2026-08-21T01:00:00.000Z",
    });
  });

  it("converts Pacific standard time to an explicit UTC instant", () => {
    expect(zonedLocalDateTimeToIso("2026-12-20T18:00")).toEqual({
      iso: "2026-12-21T02:00:00.000Z",
    });
  });

  it("rejects nonexistent and ambiguous daylight-saving wall times", () => {
    expect(zonedLocalDateTimeToIso("2026-03-08T02:30")).toHaveProperty("error");
    expect(zonedLocalDateTimeToIso("2026-11-01T01:30")).toHaveProperty("error");
  });

  it("round-trips an instant for datetime-local controls", () => {
    expect(toZonedDateTimeInputValue("2026-08-21T01:00:00.000Z")).toBe("2026-08-20T18:00");
  });

  it("labels canonical display times with the Pacific abbreviation", () => {
    expect(formatZonedDateTime("2026-08-21T01:00:00.000Z")).toBe("Aug 20, 2026, 6:00 PM PDT");
  });

  it("keeps the scheduling range between five minutes and four weeks", () => {
    expect(scheduleInputBounds(new Date("2026-08-20T19:00:00.000Z"))).toEqual({
      min: "2026-08-20T12:05",
      max: "2026-09-17T12:00",
      suggested: "2026-08-21T12:00",
    });
  });
});
