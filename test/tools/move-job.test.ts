import { describe, it, expect, vi, beforeEach } from "vitest"
import { moveJob } from "../../src/tools/move-job.js"
import { JenkinsClient } from "../../src/lib/jenkins-client.js"

describe("moveJob tool", () => {
  let mockClient: JenkinsClient

  beforeEach(() => {
    mockClient = { moveJob: vi.fn() } as any
  })

  it("should delegate to client.moveJob with default overwrite=false", async () => {
    const expected = {
      from: "src",
      to: "dest",
      url: "https://jenkins.example.com/job/dest",
      renamed: false,
    }
    vi.mocked(mockClient.moveJob).mockResolvedValue(expected)

    const result = await moveJob(mockClient, { jobName: "src", destination: "dest" })

    expect(mockClient.moveJob).toHaveBeenCalledWith("src", "dest", false)
    expect(result).toEqual(expected)
  })

  it("should pass overwrite=true through", async () => {
    vi.mocked(mockClient.moveJob).mockResolvedValue({} as any)

    await moveJob(mockClient, { jobName: "a", destination: "b", overwrite: true })

    expect(mockClient.moveJob).toHaveBeenCalledWith("a", "b", true)
  })

  it("should propagate errors from the client", async () => {
    vi.mocked(mockClient.moveJob).mockRejectedValue(
      new Error("Job already exists at destination: dest"),
    )

    await expect(
      moveJob(mockClient, { jobName: "a", destination: "dest" }),
    ).rejects.toThrow("Job already exists at destination: dest")
  })
})
