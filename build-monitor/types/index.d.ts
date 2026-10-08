export type BuildPlatform = 'ios' | 'macos' | 'android'

/** What ran the build: Xcode, Gradle, SwiftPM, fastlane, Flutter or React Native (Expo included). */
export type BuildTool = 'xcodebuild' | 'gradle' | 'swift' | 'fastlane' | 'flutter' | 'react-native'

export type BuildFilter = 'all' | BuildPlatform

export type BuildStatus = 'running' | 'background' | 'succeeded' | 'failed' | 'stopped' | 'cancelled'

/** One compiler or test diagnostic, as the build printed it. */
export type BuildIssue = {
  severity: 'error' | 'warning'
  file: string | null
  line: number | null
  message: string
  /** The code it points at, as the compiler printed it under the message, when it did. */
  code?: string
}

/** A failed test's assertion: where it failed and what it said. */
export type TestIssue = BuildIssue & { test: string }

/** What opens under a finished build: its warnings, its log, its command. */
export type DetailTab = 'warnings' | 'log' | 'command'

export type LogKind =
  | 'step'
  | 'error'
  | 'warning'
  | 'note'
  | 'pass'
  | 'fail'
  | 'code'
  | 'succeeded'
  | 'failed'
  | 'heading'
  | 'text'

/** One line of a build's log as the pane draws it: what kind of line, where it points, what it says. */
export type LogLine = { kind: LogKind; at?: string; text: string }

/** One build Claude ran, from the moment its command started. */
export type BuildRun = {
  id: string
  platform: BuildPlatform
  tool: BuildTool
  title: string
  detail: string
  /** The build's own command (`xcodebuild …`), out of the line Claude ran. */
  command: string
  /** The whole line Claude ran, `cd`s, pipes and all. */
  fullCommand: string
  startedAt: number
  endedAt: number | null
  status: BuildStatus
  errors: BuildIssue[]
  errorCount: number
  warnings: BuildIssue[]
  warningCount: number
  tests: { total: number; failed: number } | null
  /** The tests that failed, by name (`TripTests.testDuration()`), the first 20. */
  failedTests: string[]
  /** Where failed tests failed and why: XCTest's assertion lines, Swift Testing's recorded issues. */
  testIssues: TestIssue[]
  /** The output as a readable log: steps, diagnostics and tests, the compiler's command lines left out. */
  log: LogLine[]
  /** The file Claude Code kept the whole output in, when it was too long to hand back. */
  logFile: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'build-monitor': {
      builds: BuildRun[]
      /** The build the card shows, when not the latest. */
      shown: string | null
      /** What is open under a build: its warnings, log or command; null tab: nothing. */
      opened: { id: string; tab: DetailTab | null } | null
      /** The build handed to Claude to fix: queued until Claude's turn on it starts, then working. */
      asked: { id: string; state: 'queued' | 'working' } | null
      /** Which platform's builds the pane shows: all, or one. */
      filter: BuildFilter
    }
  }
}
