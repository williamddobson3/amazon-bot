; ─────────────────────────────────────────────────────────────────────
;  旧プロセス強制終了フック  (electron-builder は build/installer.nsh を
;  自動的にインストーラへ取り込む — nsis.include の既定値)
; ─────────────────────────────────────────────────────────────────────
;  インストール / アンインストールの開始時に、稼働中の旧バージョンの
;  プロセス (ウィンドウを閉じても残るヘッドレスプロセス含む) をすべて
;  強制終了する。これにより、
;    - 新バージョンが旧プロセスと同時起動して挙動が混ざる問題を防ぎ、
;    - index.node / better-sqlite3 等のロックによる上書き失敗 (EBUSY) を防ぐ。
;
;  taskkill のオプション:
;    /IM "Amazon Price Monitor.exe" : 実行ファイル名で全インスタンスを対象。
;        ※ electron-builder.yml の productName を変えたらここも合わせること。
;    /T : プロセスツリー (GPU/renderer/utility + Rust クローラ子) ごと終了。
;    /F : 応答しないプロセスも強制終了。
;  Sleep : 終了後にファイルハンドルが解放されるまで少し待つ。
;
;  注: dev の `npm start` は "electron.exe" として動くため、この taskkill の
;      対象外 (= インストール済み版のみを掃除する)。開発中の dev インスタンスは
;      手動で閉じること。

!macro killOldProcesses
  DetailPrint "Closing any running Amazon Price Monitor processes..."
  nsExec::Exec 'taskkill /F /IM "Amazon Price Monitor.exe" /T'
  Pop $0
  Sleep 1500
!macroend

; インストーラ初期化時 (ファイル展開前) に旧プロセスを終了。
!macro customInit
  !insertmacro killOldProcesses
!macroend

; アンインストール時 (ファイル削除前) に稼働中のアプリを終了。
!macro customUnInstall
  !insertmacro killOldProcesses
!macroend
