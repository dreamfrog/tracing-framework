/**
 * Copyright 2013 Google, Inc. All Rights Reserved.
 *
 * Use of this source code is governed by a BSD-style license that can be
 * found in the LICENSE file.
 */

/**
 * @fileoverview WebGL-on-OpenGL generated output.
 * This file was generated using the Web Tracing Framework generate-webgl-app
 * tool.
 *
 * sudo apt-get install libgles2-mesa-dev
 * hg clone http://hg.libsdl.org/SDL
 * cd SDL/
 * ./configure && make
 * sudo make install
 *
 * @author benvanik@google.com (Ben Vanik)
 */

#include "webgl-shared.h"


void _checkSDLError(const char* file, int line) {
  const char* error = SDL_GetError();
  if (*error != '\0') {
    printf("SDL ERROR: %s:%d %s\n", file, line, error);
    SDL_ClearError();
  }
}

GLuint _checkGLError(const char* file, int line) {
  GLuint error = glGetError();
  if (error)  {
    printf("GL ERROR: %s:%d %d\n", file, line, error);
  }
  return error;
}


bool extensions_initialized = false;
PFNGLDRAWARRAYSINSTANCEDPROC glDrawArraysInstanced = 0;
PFNGLDRAWELEMENTSINSTANCEDPROC glDrawElementsInstanced = 0;
PFNGLVERTEXATTRIBDIVISORPROC glVertexAttribDivisor = 0;

void InitializeExtensions() {
  if (extensions_initialized) {
    return;
  }
  extensions_initialized = true;

  printf("GL_VERSION: %s\n", glGetString(GL_VERSION));
  printf("GL_EXTENSIONS: %s\n", glGetString(GL_EXTENSIONS));

  if (!SDL_GL_ExtensionSupported("GL_ARB_instanced_arrays")) {
    printf("Instanced arrays extension not available!\n");
    exit(1);
  }

  glDrawArraysInstanced =
      (PFNGLDRAWARRAYSINSTANCEDPROC)SDL_GL_GetProcAddress(
          "glDrawArraysInstancedARB");
  glDrawElementsInstanced =
      (PFNGLDRAWELEMENTSINSTANCEDPROC)SDL_GL_GetProcAddress(
          "glDrawElementsInstancedARB");
  glVertexAttribDivisor =
      (PFNGLVERTEXATTRIBDIVISORPROC)SDL_GL_GetProcAddress(
          "glVertexAttribDivisorARB");
}


CanvasContext::CanvasContext(
    const char* window_title, int handle) :
    window_title_(window_title), handle_(handle),
  window_(0), gl_(0) {
  //SDL_GL_SetAttribute(SDL_GL_CONTEXT_EGL, 1);
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 2);
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 0);
  // SDL_GL_CONTEXT_PROFILE_MASK = mask SDL_GL_CONTEXT_PROFILE_ES
  SDL_GL_SetAttribute(SDL_GL_DOUBLEBUFFER, 1);
  SDL_GL_SetAttribute(SDL_GL_DEPTH_SIZE, 24);
  // SDL_GL_STENCIL_SIZE
  // SDL_GL_MULTISAMPLEBUFFERS
  // SDL_GL_MULTISAMPLESAMPLES

  char title[2048];
  sprintf(title, "%s : %d", window_title_, handle_);
  window_ = SDL_CreateWindow(
      title,
      SDL_WINDOWPOS_CENTERED,
      SDL_WINDOWPOS_CENTERED,
      800, 480,
      SDL_WINDOW_SHOWN | SDL_WINDOW_OPENGL);

  // Create GL.
  gl_ = SDL_GL_CreateContext(window_);
  SDL_GL_MakeCurrent(window_, gl_);
  CHECK_SDL();

  InitializeExtensions();

  SDL_GL_SetSwapInterval(0);
  CHECK_SDL();

  // Prepare viewport.
  SDL_GL_GetDrawableSize(window_, &width_, &height_);
  CHECK_SDL();
  glViewport(0, 0, width_, height_);
  CHECK_GL();
}

CanvasContext::~CanvasContext() {
  SDL_GL_DeleteContext(gl_);
  SDL_DestroyWindow(window_);
}

void CanvasContext::MakeCurrent(int width, int height) {
  SDL_GL_MakeCurrent(window_, gl_);
  CHECK_SDL();

  if (width != -1 && height != -1) {
    if (width != width_ || height != height_) {
      // Resized.
      width_ = width;
      height_ = height;
      SDL_SetWindowSize(window_, width_, height_);
      CHECK_SDL();
      glViewport(0, 0, width_, height_);
      CHECK_GL();
    }
  }
}

void CanvasContext::Swap() {
  SDL_GL_MakeCurrent(window_, gl_);
  CHECK_SDL();

  SDL_GL_SwapWindow(window_);
}

GLuint CanvasContext::GetObject(int handle) {
  return handle ? object_map_[handle] : 0;
}

void CanvasContext::SetObject(int handle, GLuint id) {
  object_map_[handle] = id;
}


Replay::Replay(const char* trace_name, const char* bin_name,
               const StepFunction* steps, int step_count) :
    trace_name_(trace_name), bin_name_(bin_name),
    bin_data_(0), bin_data_length_(0),
    steps_(steps), step_count_(step_count), step_index_(0) {
  SDL_Init(SDL_INIT_VIDEO);

  SDL_DisplayMode mode;
  SDL_GetDesktopDisplayMode(0, &mode);
  CHECK_SDL();
}

Replay::~Replay() {
  for (vector<CanvasContext*>::iterator it = contexts_.begin();
       it != contexts_.end(); ++it) {
    delete *it;
  }

  free(bin_data_);

  SDL_Quit();
}

bool Replay::LoadResources() {
  // Get executable path (without executable name).
  char file_path[2048];
  int file_path_size = sizeof(file_path);
#if defined(WIN32)
  const char path_sep = '\\';
  GetModuleFileName(NULL, file_path, file_path_size);
#elif defined(__APPLE__)
  const char path_sep = '/';
  _NSGetExecutablePath(file_path, file_path_size);
#else
  const char path_sep = '/';
  int file_path_length =
      readlink("/proc/self/exe", file_path, file_path_size - 1);
  if (file_path_length == -1) {
    printf("Can't find myself!\n");
    return 1;
  }
  file_path[file_path_length] = 0;
#endif
  char* last_slash = strrchr(file_path, path_sep);
  last_slash++;
  *last_slash = 0;

  // Open the .bin file.
  strcat(file_path, bin_name_);
  FILE* file = fopen(file_path, "r");
  if (!file) {
    printf("Unable to open bin file %s\n", bin_name_);
    return false;
  }

  fseek(file, 0, SEEK_END);
  bin_data_length_ = ftell(file);
  fseek(file, 0, SEEK_SET);

  bin_data_ = (uint8_t*)malloc(bin_data_length_);
  if (!bin_data_) {
    printf("Unable to allocate bin memory\n");
    return false;
  }

  fread(bin_data_, 1, bin_data_length_, file);

  fclose(file);

  return true;
}

const void* Replay::GetBinData(size_t offset, size_t length) {
  if (offset + length > bin_data_length_) {
    return NULL;
  }
  return bin_data_ + offset;
}

int Replay::Run() {
  bool running = true;
  while (running) {
    // Handle all pending SDL events.
    SDL_Event event;
    while (SDL_PollEvent(&event)) {
      switch (event.type) {
        case SDL_WINDOWEVENT_CLOSE:
        case SDL_QUIT:
          running = false;
          break;
        case SDL_WINDOWEVENT:
          printf("SDL_WINDOWEVENT(%d, %d, %d)\n",
                 event.window.event, event.window.data1, event.window.data2);
          switch (event.window.event) {
            case 14:
              running = false;
              break;
          }
          break;
        default:
          printf("SDL event: %d\n", event.type);
          break;
      }
    }
    if (!running) {
      break;
    }

    // Run next steps.
    // If we have no more steps, we exit after this loop.
    running = IssueNextStep();

    // Swap all windows.
    for (vector<CanvasContext*>::iterator it = contexts_.begin();
         it != contexts_.end(); ++it) {
      (*it)->Swap();
    }

    // TODO(benvanik): proper delay (or none?).
    SDL_Delay(16);
  }
  return 0;
}

bool Replay::IssueNextStep() {
  // Issue the next step.
  printf("STEP %d:\n", step_index_);
  StepFunction step = steps_[step_index_++];
  step(this);

  // Return true = steps remaining.
  return step_index_ < step_count_;
}

CanvasContext* Replay::CreateContext(int handle) {
  CanvasContext* context = new CanvasContext(trace_name_, handle);
  contexts_.push_back(context);
  context_map_[handle] = context;
  return context;
}

CanvasContext* Replay::MakeContextCurrent(int handle, int width, int height) {
  CanvasContext* context = context_map_[handle];
  context->MakeCurrent(width, height);
  return context;
}


extern const char* __trace_name;
extern const char* __bin_name;
extern int __step_count;
extern StepFunction* __get_steps();

int main(int argc, char** argv) {
  Replay replay(__trace_name, __bin_name, __get_steps(), __step_count);

  if (!replay.LoadResources()) {
    return 1;
  }

  return replay.Run();
}
