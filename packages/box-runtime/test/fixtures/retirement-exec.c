#include <assert.h>
#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>
#include <sys/file.h>
int main(int argc, char **argv) {
  assert(argc == 3);
  int retained = open(argv[1], O_CREAT|O_RDWR, 0600);
  int cloexec = open(argv[2], O_CREAT|O_RDWR|O_CLOEXEC, 0600);
  assert(retained >= 3 && cloexec >= 3);
  assert(flock(retained, LOCK_EX|LOCK_NB) == 0);
  assert(flock(cloexec, LOCK_EX|LOCK_NB) == 0);
  printf("READY %ld %d %d\n", (long)getpid(), retained, cloexec); fflush(stdout);
  char input; assert(read(STDIN_FILENO, &input, 1) == 1);
  char fd[32]; snprintf(fd, sizeof(fd), "%d", retained);
  char *args[] = {"bash", "--noprofile", "--norc", "-c",
    "printf 'BASH %s\\n' \"$$\"; read -r action; eval \"exec $1>&-\"; printf 'RETIRED\\n'; read -r finish", "owned", fd, NULL};
  execv("/usr/bin/bash", args);
  return 99;
}
