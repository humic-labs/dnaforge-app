use anyhow::{bail, Context, Result};
use std::env;
#[cfg(windows)]
use std::process::{Command, Stdio};

const VERSION: &str = "dna-process-guardian schema 2";

fn command_from_args(args: impl IntoIterator<Item = String>) -> Result<(u32, String, Vec<String>)> {
    let mut args = args.into_iter();
    let mut owner_flag = args.next().context("missing --owner-pid")?;
    let mut forwarded = Vec::new();
    if owner_flag == "--inspect=0" {
        let remote_flag = args
            .next()
            .filter(|value| value == "--remote-debugging-port=0")
            .context("expected the Playwright Electron debug-port pair")?;
        forwarded.extend([owner_flag, remote_flag]);
        owner_flag = args.next().context("missing --owner-pid")?;
    }
    if owner_flag != "--owner-pid" {
        bail!("expected --owner-pid before the owner process id");
    }
    let owner_pid = args
        .next()
        .context("missing owner process id")?
        .parse::<u32>()
        .context("owner process id must be an unsigned integer")?;
    if owner_pid == 0 {
        bail!("owner process id must be positive");
    }
    let separator = args.next().context("missing guarded executable")?;
    if separator != "--" {
        bail!("expected -- before the guarded executable");
    }
    let executable = args.next().context("missing guarded executable")?;
    forwarded.extend(args);
    Ok((owner_pid, executable, forwarded))
}

fn snapshot_pids(args: impl IntoIterator<Item = String>) -> Result<Vec<u32>> {
    let mut pids = Vec::new();
    for argument in args {
        let pid = argument
            .parse::<u32>()
            .context("snapshot process id must be an unsigned integer")?;
        if pid == 0 || pids.contains(&pid) || pids.len() == 3 {
            bail!("snapshot requires one to three distinct positive process ids");
        }
        pids.push(pid);
    }
    if pids.is_empty() {
        bail!("snapshot requires one to three distinct positive process ids");
    }
    Ok(pids)
}

#[cfg(windows)]
fn snapshot_parents(pids: &[u32]) -> Result<()> {
    use std::mem::{size_of, zeroed};
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::Foundation::{ERROR_NO_MORE_FILES, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error())
            .context("could not snapshot Windows processes");
    }
    let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot) };
    let mut entry: PROCESSENTRY32W = unsafe { zeroed() };
    entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
    if unsafe { Process32FirstW(snapshot.as_raw_handle(), &mut entry) } == 0 {
        return Err(std::io::Error::last_os_error()).context("could not read the process snapshot");
    }

    let mut rows = Vec::with_capacity(pids.len());
    loop {
        if pids.contains(&entry.th32ProcessID) {
            rows.push(format!(
                "{{\"ProcessId\":{},\"ParentProcessId\":{}}}",
                entry.th32ProcessID, entry.th32ParentProcessID
            ));
        }
        if unsafe { Process32NextW(snapshot.as_raw_handle(), &mut entry) } == 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(ERROR_NO_MORE_FILES as i32) {
                return Err(error).context("could not finish reading the process snapshot");
            }
            break;
        }
    }
    println!("[{}]", rows.join(","));
    Ok(())
}

#[cfg(not(windows))]
fn snapshot_parents(_: &[u32]) -> Result<()> {
    bail!("process snapshots are supported only on Windows")
}

#[cfg(windows)]
fn run_guarded() -> Result<i32> {
    use std::ffi::c_void;
    use std::mem::{size_of, zeroed};
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_FAILED, WAIT_OBJECT_0};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, OpenProcess, WaitForMultipleObjects, INFINITE, PROCESS_SYNCHRONIZE,
    };

    let (owner_pid, executable, args) = command_from_args(env::args().skip(1))?;
    let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if job.is_null() {
        return Err(std::io::Error::last_os_error()).context("CreateJobObjectW failed");
    }

    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let configured = unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            (&raw const limits).cast::<c_void>(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if configured == 0 {
        let error = std::io::Error::last_os_error();
        unsafe { CloseHandle(job) };
        return Err(error).context("SetInformationJobObject failed");
    }

    let owner = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, owner_pid) };
    if owner.is_null() {
        let error = std::io::Error::last_os_error();
        unsafe { CloseHandle(job) };
        return Err(error).context("could not bind the guardian to its owner process");
    }

    let assigned = unsafe { AssignProcessToJobObject(job, GetCurrentProcess()) };
    if assigned == 0 {
        let error = std::io::Error::last_os_error();
        unsafe {
            CloseHandle(owner);
            CloseHandle(job);
        }
        return Err(error).context("AssignProcessToJobObject failed");
    }

    if env::var_os("DNAFORGE_GUARDIAN_TEST_FAIL_BEFORE_SPAWN").is_some() {
        bail!("forced guardian setup failure before spawn");
    }

    let mut child = Command::new(&executable)
        .args(args)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .with_context(|| format!("could not start guarded executable {executable:?}"))?;
    let handles = [owner, child.as_raw_handle().cast()];
    let wait_result = unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, INFINITE) };
    if wait_result == WAIT_FAILED {
        let error = std::io::Error::last_os_error();
        unsafe {
            CloseHandle(owner);
            CloseHandle(job);
        }
        return Err(error).context("could not wait for owner or guarded child");
    }
    if wait_result == WAIT_OBJECT_0 {
        unsafe {
            CloseHandle(owner);
            CloseHandle(job);
        }
        bail!("owner process exited before the guarded child");
    }
    if wait_result != WAIT_OBJECT_0 + 1 {
        unsafe {
            CloseHandle(owner);
            CloseHandle(job);
        }
        bail!("unexpected owner/child wait result {wait_result}");
    }

    let status = child
        .wait()
        .context("could not collect the guarded child exit status")?;
    unsafe { CloseHandle(owner) };

    Ok(status.code().unwrap_or(1))
}

#[cfg(not(windows))]
fn run_guarded() -> Result<i32> {
    let _ = command_from_args(env::args().skip(1))?;
    bail!("dna-process-guardian is supported only on Windows")
}

fn main() {
    if env::args().nth(1).as_deref() == Some("--version") {
        println!("{VERSION}");
        return;
    }
    let result = if env::args().nth(1).as_deref() == Some("--snapshot-parents") {
        snapshot_pids(env::args().skip(2))
            .and_then(|pids| snapshot_parents(&pids))
            .map(|()| 0)
    } else {
        run_guarded()
    };
    match result {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("dna-process-guardian: {error:#}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{command_from_args, snapshot_pids};

    #[test]
    fn snapshot_accepts_only_distinct_positive_pids_in_the_fixture_chain() {
        assert_eq!(
            snapshot_pids(["11", "12", "13"].map(String::from)).unwrap(),
            [11, 12, 13]
        );
        for input in [
            &[][..],
            &["0"],
            &["11", "11"],
            &["1", "2", "3", "4"],
            &["bad"],
        ] {
            assert!(snapshot_pids(input.iter().map(|argument| argument.to_string())).is_err());
        }
    }

    #[test]
    fn standard_guardian_command_preserves_executable_and_arguments() {
        let input = [
            "--owner-pid",
            "42",
            "--",
            r"C:\Path With Spaces\worker.exe",
            "arg",
        ];
        let command = command_from_args(input.map(String::from)).unwrap();
        assert_eq!(command, (42, input[3].into(), vec!["arg".into()]));
    }

    #[test]
    fn playwright_electron_flags_are_forwarded_before_application_arguments() {
        let input = [
            "--inspect=0",
            "--remote-debugging-port=0",
            "--owner-pid",
            "42",
            "--",
            r"C:\Path With Spaces\electron.exe",
            "app.js",
            "--test-profile",
        ];
        let command = command_from_args(input.map(String::from)).unwrap();
        assert_eq!(
            command,
            (
                42,
                input[5].into(),
                vec![
                    input[0].into(),
                    input[1].into(),
                    input[6].into(),
                    input[7].into(),
                ]
            )
        );
    }

    #[test]
    fn incomplete_or_non_ephemeral_playwright_prefix_is_rejected() {
        for input in [
            ["--inspect=0", "--owner-pid", "42", "--", "electron.exe"],
            [
                "--inspect=0",
                "--remote-debugging-port=9222",
                "--owner-pid",
                "42",
                "--",
            ],
            [
                "--inspect=0.0.0.0:9229",
                "--remote-debugging-port=0",
                "--owner-pid",
                "42",
                "--",
            ],
        ] {
            assert!(command_from_args(input.map(String::from)).is_err());
        }
    }
}
