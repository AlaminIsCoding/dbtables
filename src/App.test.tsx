import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import { getAppStatus, type AppStatusResponse } from "./services/appStatus";

vi.mock("./services/appStatus", () => ({
  getAppStatus: vi.fn(),
}));

const getAppStatusMock = vi.mocked(getAppStatus);

const okResponse: AppStatusResponse = {
  app: "dbtables",
  status: "ok",
  message: "dbtables backend is ready.",
};

afterEach(cleanup);

describe("App", () => {
  beforeEach(() => {
    getAppStatusMock.mockReset();
  });

  it("renders the application heading", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "dbtables" })).toBeTruthy();
  });

  it("shows a pending state then the backend response", async () => {
    getAppStatusMock.mockResolvedValue(okResponse);

    render(<App />);
    fireEvent.click(
      screen.getByRole("button", { name: "Request backend status" }),
    );

    expect(screen.getByText("Waiting for the backend…")).toBeTruthy();
    expect(
      await screen.findByText(/dbtables backend is ready\./),
    ).toBeTruthy();
    expect(getAppStatusMock).toHaveBeenCalledWith({ requestedBy: "frontend" });
  });

  it("shows an error state when the backend request fails", async () => {
    getAppStatusMock.mockRejectedValue(new Error("backend unavailable"));

    render(<App />);
    fireEvent.click(
      screen.getByRole("button", { name: "Request backend status" }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("backend unavailable");
    expect(
      screen.getByRole("button", { name: "Request backend status" }),
    ).toBeTruthy();
  });
});
