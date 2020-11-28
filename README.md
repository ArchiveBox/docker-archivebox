# docker-archivebox

The official Docker image for [ArchiveBox](https://github.com/ArchiveBox/ArchiveBox), the self-hosted internet archiving solution.

https://hub.docker.com/r/archivebox/archivebox

## Quickstart

**Pull the image:**
```bash
docker pull archivebox/archivebox
docker image ls archivebox/archivebox
```

**Try it out:**
```bash
docker run archivebox/archivebox version

mkdir data && cd data
docker run -v $PWD:/data -it archivebox/archivebox init
docker run -v $PWD:/data -it archivebox/archivebox add 'https://example.com'
docker run -v $PWD:/data -it -p 8000:8000 archivebox/archivebox server 0.0.0.0:8000
```
---

Tested on amd64/x86 and armv7, should work on all systems that support Docker.

---

## Development

The image is built using `docker`: https://docs.docker.com/get-docker/ and hosted on Docker Hub & Github Packages: https://hub.docker.com/r/archivebox.

https://hub.docker.com/r/archivebox/archivebox

The config file / package definition is here: [`ArchiveBox/Dockerfile`](https://github.com/ArchiveBox/ArchiveBox/blob/master/Dockerfile).

To build this package, make sure you are in the ArchiveBox main repo first.

```bash
cd ArchiveBox/
git pull --recurse-submodules

# Build the docker image
./bin/build_docker.sh

# Push the image to Docker Hub & Github Packages
./bin/release.sh
```
