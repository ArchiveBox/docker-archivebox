# docker-archivebox

The official Docker image for [ArchiveBox](https://github.com/ArchiveBox/ArchiveBox), the self-hosted internet archiving solution.

https://hub.docker.com/r/archivebox/archivebox

```bash
docker pull archivebox/archivebox

# using Docker Compose
mkdir -p ~/archivebox/data && cd ~/archivebox
curl -fsSL 'https://docker-compose.archivebox.io' > docker-compose.yml
docker compose up

# using Docker:
mkdir -p ~/archivebox/data && cd ~/archivebox/data
docker run -v $PWD:/data -it archivebox/archivebox init
```

- [`Dockerfile`](https://github.com/ArchiveBox/ArchiveBox/blob/main/Dockerfile)
- [`docker-compose.yml`](https://github.com/ArchiveBox/ArchiveBox/blob/main/docker-compose.yml)
- [`archivebox-kubernetes.yml`](https://github.com/ArchiveBox/docker-archivebox/blob/master/archivebox.yml)
- [ArchiveBox Docker Quickstart](https://github.com/ArchiveBox/ArchiveBox#quickstart) + [Usage](https://github.com/ArchiveBox/ArchiveBox/wiki/Docker) + [Configuration](https://github.com/ArchiveBox/ArchiveBox/wiki/Docker#configuration) + [Upgrading](https://github.com/ArchiveBox/ArchiveBox/wiki/Upgrading-or-Merging-Archives) documentation

#### Tags available

It's recommended to use `:latest` (stable, cross-platform build for all supported architectures)

- `:latest` (the default stable tag, 1:1 with `:stable`/`:master`)
- `:dev`/`:main`/`:<branchname>` (tags for each git branch, use these to try a BETA or specific PR)
- `sha-2c7be14`/`:sha-<commitid>` (tags for each git commit, use these to pin an exact codebase version)

*For a full list of the published images: https://hub.docker.com/r/archivebox/archivebox/tags*

<img width="500px" alt="Docker Hub Screenshot" src="https://user-images.githubusercontent.com/511499/147287184-6f1201f8-6827-4002-a6a3-3aae7eb859d4.png">


#### ✅ Operating Systems Supported

**Linux, macOS, Windows**  
  
*Any OS where [Docker](https://docs.docker.com/engine/install/) or [Docker Desktop](https://docs.docker.com/get-docker/) is supported.*

#### ✅ CPU Architectures Supported

- `amd64` all x86 64-bit Intel/AMD processors
- `arm64`/`aarch64` Raspberry Pi v4+, M1 or newer Macs, and newer ARM-based systems (>= ARM v8)

#### ❌ CPU Architectures _NOT_ Supported

- `i386` x86 **32-bit** Intel/AMD processors
- `arm/v7`/`arm/v6`/`arm/v5` Raspberry Pi v3 and older ARM systems
- `riscv64`/`riscv32`/`ppc64le`/`ppc32`/`s390x` or other architectures

---

## Docker Compose Usage

See full [`docker-compose.yml`](https://github.com/ArchiveBox/ArchiveBox/blob/main/docker-compose.yml) and the [Docker ArchiveBox docs](https://github.com/ArchiveBox/ArchiveBox/wiki/Docker) for more complete examples and documentation.
```yaml
services:
    archivebox:
        image: archivebox/archivebox:dev
        ports:
            - 8000:8000
        environment:
            # add any ArchiveBox config options you want here
            - ALLOWED_HOSTS=archivebox.example.com
            - ADMIN_USERNAME=admin
            - ADMIN_PASSWORD=...
            - MEDIA_MAX_SIZE=750m
        volumes:
            - ./data:/data
```

---

## Dockerfile Usage

To use ArchiveBox in your own `Dockerfile`, add the following to it:
```Dockerfile
FROM python:3.12-slim

WORKDIR /data
RUN pip install archivebox==0.8.5rc51
RUN archivebox install

RUN useradd -ms /bin/bash archivebox && chown -R archivebox /data
```
*(replace `0.8.5rc51` with [latest release](https://github.com/ArchiveBox/ArchiveBox/releases))*

See more:

- [`Dockerfile`](https://github.com/ArchiveBox/ArchiveBox/blob/dev/Dockerfile): Full production-ready image with optimized build caching and layer sizes

---

## Kubernetes

(BETA: Advanced users only, ArchiveBox does not test releases on Kubernetes, but it should work in theory)

[`./archivebox.yml`](https://github.com/ArchiveBox/docker-archivebox/blob/master/archivebox.yml) contains an example Kubernetes manifest (with `rook-ceph-rbd` and `metallb`).

Use as-is, or edit to your needs, objects will be created in namespace: `archivebox`.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: archivebox-deployment
spec:
  selector:
    matchLabels:
      app: archivebox
  replicas: 1
  template:
    metadata:
      labels:
        app: archivebox
    spec:
      containers:
        - name: archivebox
          args: ["server", "--quick-init", "0.0.0.0:8000"]
          image: archivebox/archivebox
          ports:
            - containerPort: 8000
              protocol: TCP
              name: http
          volumeMounts:
            - mountPath: /data
              name: archivebox
      restartPolicy: Always
      volumes:
        - name: archivebox
          persistentVolumeClaim:
            claimName: archivebox
```

```bash
# run this to apply the configuration
kubectl apply -f archivebox.yml
```

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
docker login
./bin/release_docker.sh 0.7.1 latest
```

### Inspecting the image layers

```bash
docker image ls archivebox/archivebox

docker image inspect <image id>  # view image details
docker image history <image id>  # view image layer sizes
```
---


*Please note: The old image at [`nikisweeting/archivebox`](https://hub.docker.com/r/nikisweeting/archivebox) is deprecated, use [`archivebox/archivebox`](https://hub.docker.com/r/archivebox/archivebox) instead.*

