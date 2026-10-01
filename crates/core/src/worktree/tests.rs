use super::*;
async fn repo() -> PathBuf {
    let path = std::env::temp_dir().join(format!("sc-p27-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&path).await.unwrap();
    git(&path, &["init"]).await.unwrap();
    git(&path, &["config", "user.email", "test@example.invalid"])
        .await
        .unwrap();
    git(&path, &["config", "user.name", "Test"]).await.unwrap();
    tokio::fs::write(path.join("source.txt"), "original")
        .await
        .unwrap();
    git(&path, &["add", "."]).await.unwrap();
    git(&path, &["commit", "-m", "initial"]).await.unwrap();
    tokio::fs::canonicalize(path).await.unwrap()
}
#[tokio::test]
async fn isolated_reusable_and_cleanup_preserves_dirty_and_references() {
    let project = repo().await;
    tokio::fs::write(project.join("source.txt"), "local draft")
        .await
        .unwrap();
    let task = uuid::Uuid::new_v4().to_string();
    let entry = TaskWorktree::create(&project, "space", &task)
        .await
        .unwrap();
    assert_eq!(
        TaskWorktree::create(&project, "space", &task)
            .await
            .unwrap()
            .path,
        entry.path
    );
    assert_eq!(
        tokio::fs::read_to_string(entry.path.join("source.txt"))
            .await
            .unwrap(),
        "original"
    );
    tokio::fs::write(entry.path.join("source.txt"), "isolated")
        .await
        .unwrap();
    assert_eq!(
        tokio::fs::read_to_string(project.join("source.txt"))
            .await
            .unwrap(),
        "local draft"
    );
    assert!(
        TaskWorktree::cleanup(&project, &[], &[])
            .await
            .unwrap()
            .removed
            .is_empty()
    );
    git(&entry.path, &["restore", "source.txt"]).await.unwrap();
    assert!(
        TaskWorktree::cleanup(&project, &[], std::slice::from_ref(&entry.path))
            .await
            .unwrap()
            .removed
            .is_empty()
    );
    assert!(
        TaskWorktree::cleanup(&project, std::slice::from_ref(&task), &[])
            .await
            .unwrap()
            .removed
            .is_empty()
    );
    let other = project
        .parent()
        .unwrap()
        .join(format!("other-{}", uuid::Uuid::new_v4()));
    git(
        &project,
        &["worktree", "add", "--detach", &other.to_string_lossy()],
    )
    .await
    .unwrap();
    assert_eq!(
        TaskWorktree::cleanup(&project, &[], &[])
            .await
            .unwrap()
            .removed,
        vec![task]
    );
    assert!(!entry.path.exists());
    git(
        &project,
        &[
            "show-ref",
            "--verify",
            &format!("refs/heads/{}", entry.branch),
        ],
    )
    .await
    .unwrap();
    assert!(other.exists());
    git(&project, &["worktree", "remove", &other.to_string_lossy()])
        .await
        .unwrap();
    tokio::fs::remove_dir_all(project).await.unwrap();
}
#[tokio::test]
async fn copies_explicit_files_and_rejects_escape_and_tracked_files() {
    let project = repo().await;
    tokio::fs::write(project.join(".env"), "TEST=placeholder")
        .await
        .unwrap();
    tokio::fs::write(project.join(".worktreeinclude"), "# config\n.env\n")
        .await
        .unwrap();
    let entry = TaskWorktree::create(&project, "space", &uuid::Uuid::new_v4().to_string())
        .await
        .unwrap();
    assert_eq!(
        tokio::fs::read_to_string(entry.path.join(".env"))
            .await
            .unwrap(),
        "TEST=placeholder"
    );
    assert!(
        TaskWorktree::cleanup(&project, &[], &[])
            .await
            .unwrap()
            .removed
            .is_empty()
    );
    for bad in ["../escape", "/tmp/escape", ".git/config", "source.txt"] {
        tokio::fs::write(project.join(".worktreeinclude"), bad)
            .await
            .unwrap();
        let task = uuid::Uuid::new_v4().to_string();
        assert!(
            TaskWorktree::create(&project, "space", &task)
                .await
                .is_err()
        );
        assert!(
            git(
                &project,
                &[
                    "show-ref",
                    "--verify",
                    &format!("refs/heads/supercode/task-{task}")
                ]
            )
            .await
            .is_err()
        );
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(project.join(".env"), project.join("link")).unwrap();
        tokio::fs::write(project.join(".worktreeinclude"), "link")
            .await
            .unwrap();
        assert!(
            TaskWorktree::create(&project, "space", &uuid::Uuid::new_v4().to_string())
                .await
                .is_err()
        );
    }
    git(
        &project,
        &[
            "worktree",
            "remove",
            "--force",
            &entry.path.to_string_lossy(),
        ],
    )
    .await
    .unwrap();
    tokio::fs::remove_dir_all(project).await.unwrap();
}

#[tokio::test]
async fn failed_copy_rolls_back_only_new_worktree_and_branch() {
    let project = repo().await;
    tokio::fs::write(project.join("config.local"), "placeholder")
        .await
        .unwrap();
    // 重复目标模拟建树后复制阶段失败，证明 Git 和记录一并回滚。
    tokio::fs::write(
        project.join(".worktreeinclude"),
        "config.local\nconfig.local\n",
    )
    .await
    .unwrap();
    let task = uuid::Uuid::new_v4().to_string();
    assert!(
        TaskWorktree::create(&project, "space", &task)
            .await
            .is_err()
    );
    assert!(TaskWorktree::list(&project).await.unwrap().is_empty());
    assert!(
        git(
            &project,
            &[
                "show-ref",
                "--verify",
                &format!("refs/heads/supercode/task-{task}")
            ]
        )
        .await
        .is_err()
    );
    assert_eq!(
        tokio::fs::read_to_string(project.join("config.local"))
            .await
            .unwrap(),
        "placeholder"
    );
    tokio::fs::remove_dir_all(project).await.unwrap();
}

#[tokio::test]
async fn externally_missing_directory_is_unregistered_without_global_prune() {
    let project = repo().await;
    let task = uuid::Uuid::new_v4().to_string();
    let entry = TaskWorktree::create(&project, "space", &task)
        .await
        .unwrap();
    tokio::fs::remove_dir_all(&entry.path).await.unwrap();
    assert_eq!(
        TaskWorktree::cleanup(&project, &[], &[])
            .await
            .unwrap()
            .removed,
        vec![task]
    );
    assert!(
        !git(&project, &["worktree", "list", "--porcelain"])
            .await
            .unwrap()
            .contains(&entry.path.to_string_lossy().to_string())
    );
    tokio::fs::remove_dir_all(project).await.unwrap();
}
