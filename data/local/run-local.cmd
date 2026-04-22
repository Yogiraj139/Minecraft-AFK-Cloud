@echo off
cd /d "C:\Users\KISHOR NAIK\Documents\New project"
set NODE_ENV=development
set PORT=3210
set AUTO_START_ON_BOOT=false
set ADMIN_USERNAME=admin
set ADMIN_PASSWORD=CloudAFK-Local-Admin-2026!
set SESSION_SECRET=1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef
set APP_SECRET=abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890
set DATA_DIR=data/local
"C:\Program Files\nodejs\npm.cmd" start > data\local\server.out.log 2> data\local\server.err.log
