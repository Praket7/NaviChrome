use crate::jobs::Journal;
use std::{
    fs,
    fs::File,
    io,
    path::{Path, PathBuf},
};

#[derive(Debug, thiserror::Error)]
pub(crate) enum SessionStateError {
    #[error("session state filesystem error: {0}")]
    Io(#[from] io::Error),
    #[error("session journal error: {0}")]
    Journal(#[from] crate::jobs::JournalError),
    #[error("cannot generate session identifier")]
    Random,
}

pub(crate) fn create_session_state_dir(
    root: &Path,
    pid: u32,
) -> Result<PathBuf, SessionStateError> {
    let sessions = root.join("sessions");
    fs::create_dir_all(&sessions)?;
    loop {
        let mut random = [0; 8];
        getrandom::fill(&mut random).map_err(|_| SessionStateError::Random)?;
        let path = sessions.join(format!(
            "{pid}-{}",
            random
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        ));
        match fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    }
}

pub(crate) fn prune_resolved_sessions(root: &Path, active: &Path) -> Result<(), SessionStateError> {
    let sessions = root.join("sessions");
    let entries = match fs::read_dir(sessions) {
        Ok(entries) => entries,
        Err(_) => return Ok(()),
    };
    for entry in entries {
        let Ok(entry) = entry else {
            continue;
        };
        if !entry.file_type().is_ok_and(|kind| kind.is_dir()) || entry.path() == active {
            continue;
        }
        let path = entry.path();
        let Ok(lock) = super::acquire_state_directory_lock(&path) else {
            continue;
        };
        let journal_path = path.join("operations.sqlite");
        if !journal_path.is_file() {
            continue;
        }
        let Ok(journal) = Journal::open(&journal_path) else {
            continue;
        };
        if journal.recover_after_restart().is_err() {
            continue;
        }
        let unresolved = match journal.has_unresolved_operations() {
            Ok(unresolved) => unresolved,
            Err(_) => continue,
        };
        drop(journal);
        if !unresolved {
            if remove_journal_files(&path).is_err() {
                continue;
            }
            drop(lock);
            let _ = fs::remove_dir_all(path);
        } else {
            drop(lock);
        }
    }
    Ok(())
}

fn remove_journal_files(path: &Path) -> Result<(), SessionStateError> {
    for name in [
        "operations.sqlite",
        "operations.sqlite-wal",
        "operations.sqlite-shm",
    ] {
        match fs::remove_file(path.join(name)) {
            Ok(()) => (),
            Err(error) if error.kind() == io::ErrorKind::NotFound => (),
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

pub(crate) fn cleanup_resolved_session(
    path: &Path,
    journal: Journal,
    lock: File,
) -> Result<bool, SessionStateError> {
    if journal.has_unresolved_operations()? {
        return Ok(false);
    }
    drop(journal);
    remove_journal_files(path)?;
    drop(lock);
    fs::remove_dir_all(path)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_root() -> PathBuf {
        let mut random = [0; 8];
        getrandom::fill(&mut random).unwrap();
        std::env::temp_dir().join(format!(
            "navichrome-session-state-{}-{}",
            std::process::id(),
            random
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        ))
    }

    #[test]
    fn process_directories_are_unique_and_resolved_sessions_are_pruned() {
        let root = temp_root();
        let a = create_session_state_dir(&root, 7).unwrap();
        let b = create_session_state_dir(&root, 7).unwrap();
        assert_ne!(a, b);
        for path in [&a, &b] {
            Journal::open(path.join("operations.sqlite")).unwrap();
        }
        prune_resolved_sessions(&root, &a).unwrap();
        assert!(a.exists());
        assert!(!b.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pruning_keeps_locked_unresolved_and_unreadable_sessions() {
        let root = temp_root();
        let active = create_session_state_dir(&root, 1).unwrap();
        let locked = create_session_state_dir(&root, 2).unwrap();
        let unresolved = create_session_state_dir(&root, 3).unwrap();
        let unreadable = create_session_state_dir(&root, 4).unwrap();
        let abandoned = create_session_state_dir(&root, 5).unwrap();
        let _lock = super::super::acquire_state_directory_lock(&locked).unwrap();
        let journal = Journal::open(unresolved.join("operations.sqlite")).unwrap();
        let operation = journal
            .admit("p", "s", "k", &json!({"op":"click"}))
            .unwrap()
            .operation;
        journal.start("p", "s", &operation.id).unwrap();
        journal
            .record_dispatch("p", "s", &operation.id, "dispatch")
            .unwrap();
        Journal::open(abandoned.join("operations.sqlite"))
            .unwrap()
            .admit("p", "s", "k", &json!({"op":"click"}))
            .unwrap();
        fs::write(
            unreadable.join("operations.sqlite"),
            b"not a sqlite database",
        )
        .unwrap();
        prune_resolved_sessions(&root, &active).unwrap();
        assert!(active.exists());
        drop(super::super::acquire_state_directory_lock(&active).unwrap());
        assert!(locked.exists());
        assert!(unresolved.exists());
        assert!(unreadable.exists());
        assert!(
            !abandoned.exists(),
            "accepted pre-dispatch work recovers as failed"
        );
        drop(journal);
        drop(_lock);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn clean_shutdown_removes_resolved_session_and_retains_unknown_delivery() {
        let root = temp_root();
        let resolved = create_session_state_dir(&root, 1).unwrap();
        let lock = super::super::acquire_state_directory_lock(&resolved).unwrap();
        let journal = Journal::open(resolved.join("operations.sqlite")).unwrap();
        assert!(cleanup_resolved_session(&resolved, journal, lock).unwrap());
        assert!(!resolved.exists());

        let unresolved = create_session_state_dir(&root, 2).unwrap();
        let lock = super::super::acquire_state_directory_lock(&unresolved).unwrap();
        let journal = Journal::open(unresolved.join("operations.sqlite")).unwrap();
        let operation = journal
            .admit("p", "s", "k", &json!({"op":"click"}))
            .unwrap()
            .operation;
        journal.start("p", "s", &operation.id).unwrap();
        journal
            .record_dispatch("p", "s", &operation.id, "dispatch")
            .unwrap();
        assert!(!cleanup_resolved_session(&unresolved, journal, lock).unwrap());
        assert!(unresolved.exists());
        fs::remove_dir_all(root).unwrap();
    }
}
