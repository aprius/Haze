using System;
using System.Linq;
using System.Text.RegularExpressions;
using UnityEditor;
using UnityEditor.TestTools.TestRunner.Api;
using UnityEngine;

namespace Haze.Ide.Editor
{
    /// <summary>
    /// Runs Unity Test Framework tests for Haze (its Code Vision "Run" and
    /// Tests tool window) and reports each result over the link. Only compiled
    /// when com.unity.test-framework is installed (see the asmdef).
    /// </summary>
    [InitializeOnLoad]
    static class HazeTests
    {
        /// <summary>A run Haze started is in progress: kept across the domain reloads of Play Mode tests.</summary>
        const string k_Active = "Haze.Tests.Active";

        static HazeTests()
        {
            HazeLink.RunTests = Run;
            // Registered again after every domain reload, which Play Mode tests cause mid-run.
            ScriptableObject.CreateInstance<TestRunnerApi>().RegisterCallbacks(new Callbacks());
        }

        static void Run(string pattern)
        {
            Regex re;
            try
            {
                re = new Regex(pattern);
            }
            catch (ArgumentException e)
            {
                Finished(0, 0, 0, e.Message);
                return;
            }
            var api = ScriptableObject.CreateInstance<TestRunnerApi>();
            // Edit Mode and Play Mode tests live in different assemblies: run the modes that have a match.
            api.RetrieveTestList(TestMode.EditMode, edit => api.RetrieveTestList(TestMode.PlayMode, play =>
            {
                var filters = new[] { (mode: TestMode.EditMode, tests: edit), (mode: TestMode.PlayMode, tests: play) }
                    .Where(m => Matches(m.tests, re))
                    .Select(m => new Filter { testMode = m.mode, groupNames = new[] { pattern } })
                    .ToArray();
                if (filters.Length == 0)
                {
                    Finished(0, 0, 0, "No tests match. Unity lists tests of assemblies that reference the Test Framework (test assemblies).");
                    return;
                }
                SessionState.SetBool(k_Active, true);
                HazeLink.Post($"{{\"t\":\"testRunStarted\",\"pattern\":{Json.Str(pattern)}}}");
                api.Execute(new ExecutionSettings(filters));
            }));
        }

        static bool Matches(ITestAdaptor test, Regex re) =>
            test != null && ((!test.IsSuite && re.IsMatch(test.FullName)) || (test.HasChildren && test.Children.Any(c => Matches(c, re))));

        static void Finished(int passed, int failed, int skipped, string error)
        {
            HazeLink.Post("{\"t\":\"testRunFinished\"," +
                          $"\"passed\":{passed},\"failed\":{failed},\"skipped\":{skipped}," +
                          $"\"error\":{Json.Str(error)}}}");
        }

        static string Status(TestStatus status)
        {
            switch (status)
            {
                case TestStatus.Passed: return "passed";
                case TestStatus.Failed: return "failed";
                case TestStatus.Skipped: return "skipped";
                default: return "inconclusive";
            }
        }

        class Callbacks : ICallbacks
        {
            static bool Active => SessionState.GetBool(k_Active, false);

            public void RunStarted(ITestAdaptor testsToRun) { }

            public void RunFinished(ITestResultAdaptor result)
            {
                if (!Active) return;
                SessionState.SetBool(k_Active, false);
                Finished(result.PassCount, result.FailCount, result.SkipCount, null);
            }

            public void TestStarted(ITestAdaptor test)
            {
                if (!Active || test.IsSuite) return;
                HazeLink.Post($"{{\"t\":\"testStarted\",\"fullName\":{Json.Str(test.FullName)}}}");
            }

            public void TestFinished(ITestResultAdaptor result)
            {
                if (!Active || result.Test.IsSuite) return;
                HazeLink.Post("{\"t\":\"testFinished\"," +
                              $"\"fullName\":{Json.Str(result.FullName)}," +
                              $"\"name\":{Json.Str(result.Name)}," +
                              $"\"status\":{Json.Str(Status(result.TestStatus))}," +
                              $"\"duration\":{(result.Duration * 1000).ToString("0.###", System.Globalization.CultureInfo.InvariantCulture)}," +
                              $"\"message\":{Json.Str(string.IsNullOrEmpty(result.Message) ? null : result.Message)}," +
                              $"\"stack\":{Json.Str(string.IsNullOrEmpty(result.StackTrace) ? null : result.StackTrace)}," +
                              $"\"output\":{Json.Str(string.IsNullOrEmpty(result.Output) ? null : result.Output)}" +
                              "}");
            }
        }
    }
}
