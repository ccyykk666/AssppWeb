import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeAll, describe, expect, it, vi } from "vitest";
import DownloadItem from "../../src/components/Download/DownloadItem";
import { getInstallInfo } from "../../src/api/install";
import i18n from "../../src/i18n";
import type { DownloadTask } from "../../src/types";

const completedTask = {
  id: "task-123",
  software: {
    id: 123,
    name: "Test App",
    version: "1.0.0",
    artworkUrl: "",
  },
  accountHash: "account-hash",
  status: "completed",
  progress: 100,
  speed: "0 B/s",
  hasFile: true,
  createdAt: "2026-10-01T00:00:00.000Z",
} as DownloadTask;

function renderItem(task: DownloadTask) {
  return render(
    <MemoryRouter>
      <DownloadItem
        task={task}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onDelete={vi.fn()}
        onInstall={vi.fn()}
      />
    </MemoryRouter>,
  );
}

describe("DownloadItem installation action", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en-US");
  });

  it("installs a completed package directly from the list", () => {
    renderItem(completedTask);

    const install = screen.getByRole("link", { name: "Install" });
    expect(install).toHaveAttribute(
      "href",
      getInstallInfo(completedTask.id).installUrl,
    );
    expect(
      screen.getByRole("link", { name: "View Package" }),
    ).toHaveAttribute("href", `/downloads/${completedTask.id}`);
    const actions = screen.getAllByRole("link");
    expect(actions.indexOf(screen.getByRole("link", { name: "View Package" })))
      .toBeLessThan(actions.indexOf(install));
  });

  it.each([
    { ...completedTask, status: "downloading", hasFile: false },
    { ...completedTask, status: "completed", hasFile: false },
  ])("hides installation when no completed file is available", (task) => {
    renderItem(task as DownloadTask);
    expect(
      screen.queryByRole("link", { name: "Install" }),
    ).not.toBeInTheDocument();
  });
});
