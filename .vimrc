" ~/.vimrc — 极简版（服务器友好）

" leader
let mapleader = " "

" 基本设置
set nocompatible
filetype plugin indent on
syntax on
set encoding=utf-8
set noerrorbells
set novisualbell

" 显示与导航
set number
set ruler
set showcmd

" 缩进（常见安全默认）
set autoindent  " Auto-indent new lines
set shiftwidth=4  " Number of auto-indent spaces
set smartindent " Enable smart-indent
set smarttab  " Enable smart-tabs
set softtabstop=4 " Number of spaces per Tab
" set expandtab " Use spaces instead of tabs

" 搜索
set ignorecase
set smartcase
set incsearch
set hlsearch

" 性能/延迟
set lazyredraw
set ttyfast
set updatetime=300
set timeoutlen=500

" 不启用鼠标（服务器通常不要）`
set mouse=

:tnoremap <Esc> <C-\><C-n>
