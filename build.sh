#!/bin/bash
WORKSPACE=$(pwd)
if [ ! -d "$WORKSPACE/flutter" ]; then
  cd "$WORKSPACE"
  curl -O https://storage.googleapis.com/flutter_infra_release/releases/stable/linux/flutter_linux_3.24.0-stable.tar.xz
  tar xf flutter_linux_3.24.0-stable.tar.xz
fi
export PATH="$PATH:$WORKSPACE/flutter/bin"
cd "$WORKSPACE/frontend"
flutter config --enable-web
flutter build web --release

