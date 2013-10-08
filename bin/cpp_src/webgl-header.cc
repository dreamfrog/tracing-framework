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

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <unordered_map>
#include <vector>

#include <SDL.h>

#include <GLES2/gl2.h>
#include <GLES2/gl2ext.h>

using namespace std;


#if defined(__GNUC__)
#define _countof(a) (sizeof(a) / sizeof(a[0]))
#endif  // __GNUC__


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
#define  CHECK_SDL(...)   _checkSDLError(__FILE__, __LINE__)
#define  CHECK_GL(...)    _checkGLError(__FILE__, __LINE__)


typedef void (*PFNGLDRAWARRAYSINSTANCEDPROC)(
    GLenum, GLint, GLsizei, GLsizei);
typedef void (*PFNGLDRAWELEMENTSINSTANCEDPROC)(
    GLenum, GLsizei, GLenum, const GLvoid*, GLsizei);
typedef void (*PFNGLVERTEXATTRIBDIVISORPROC)(
    GLuint index, GLuint divisor);

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


class Replay;
typedef void (*StepFunction)(Replay*);


class CanvasContext {
public:
  CanvasContext(const char* window_title, int handle) :
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
  ~CanvasContext() {
    SDL_GL_DeleteContext(gl_);
    SDL_DestroyWindow(window_);
  }

  void MakeCurrent(int width = -1, int height = -1) {
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

  void Swap() {
    SDL_GL_MakeCurrent(window_, gl_);
    CHECK_SDL();

    SDL_GL_SwapWindow(window_);
  }

  GLuint GetObject(int handle) {
    return handle ? object_map_[handle] : 0;
  }

  void SetObject(int handle, GLuint id) {
    object_map_[handle] = id;
  }

private:
  const char*     window_title_;
  int             handle_;
  SDL_Window*     window_;
  SDL_GLContext   gl_;

  int             width_;
  int             height_;

  unordered_map<int, GLuint> object_map_;
};


class Replay {
public:
  Replay(const char* trace_name,
         const StepFunction* steps, int step_count) :
      trace_name_(trace_name),
      steps_(steps), step_count_(step_count), step_index_(0) {
    SDL_Init(SDL_INIT_VIDEO);

    SDL_DisplayMode mode;
    SDL_GetDesktopDisplayMode(0, &mode);
    CHECK_SDL();
  }
  ~Replay() {
    for (vector<CanvasContext*>::iterator it = contexts_.begin();
         it != contexts_.end(); ++it) {
      delete *it;
    }

    SDL_Quit();
  }

  void LoadResources() {
  }

  int Run() {
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

  bool IssueNextStep() {
    // Issue the next step.
    printf("STEP %d:\n", step_index_);
    StepFunction step = steps_[step_index_++];
    step(this);

    // Return true = steps remaining.
    return step_index_ < step_count_;
  }

  CanvasContext* CreateContext(int handle) {
    CanvasContext* context = new CanvasContext(trace_name_, handle);
    contexts_.push_back(context);
    context_map_[handle] = context;
    return context;
  }

  CanvasContext* MakeContextCurrent(
      int handle, int width = -1, int height = -1) {
    CanvasContext* context = context_map_[handle];
    context->MakeCurrent(width, height);
    return context;
  }

private:
  const char* trace_name_;
  const StepFunction* steps_;
  int   step_count_;
  int   step_index_;

  vector<CanvasContext*> contexts_;
  unordered_map<int, CanvasContext*> context_map_;
};
